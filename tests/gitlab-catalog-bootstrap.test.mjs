import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bootstrapGitLabCatalog, GITLAB_CATALOG_DESCRIPTION } from "../src/gitlab-catalog-bootstrap.mjs";
import { GitLabInstallationStore } from "../src/gitlab-installations.mjs";

test("GitLab Catalog bootstrap creates a public catalog project, component files and semver tag", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-gitlab-catalog-"));
  const db = path.join(dir, "installations.sqlite");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const config = {
    gitlabBaseUrl: "https://gitlab.example.com",
    oauthClientId: "client",
    oauthClientSecret: "secret",
    oauthRedirectUri: "https://reviewer.example.com/oauth/gitlab/callback",
    webhookUrl: "https://reviewer.example.com/webhooks/gitlab",
    installationsDb: db,
    tokenEncryptionKey: "catalog-test-encryption-key-at-least-32-bytes",
    oauthStateTtlMs: 600000,
    installSessionTtlMs: 3600000,
    maxDiscoverProjects: 100,
    maxInstallProjects: 10
  };

  const store = new GitLabInstallationStore({ filename: db, encryptionKey: config.tokenEncryptionKey });
  store.upsertInstallation({
    baseUrl: config.gitlabBaseUrl,
    userId: 42,
    username: "triombus",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenExpiresAt: Date.now() + 3600000
  });
  store.close();

  const writes = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || "GET";
    const api = url.pathname.replace(/^\/api\/v4/, "");

    if (method === "GET" && api === "/projects/triombus%2Fpeerivo-reviewer") return Response.json({ message: "404" }, { status: 404 });
    if (method === "POST" && api === "/projects") {
      const body = JSON.parse(options.body);
      assert.equal(body.visibility, "public");
      assert.equal(body.cicd_catalog_enabled, true);
      assert.equal(body.description, GITLAB_CATALOG_DESCRIPTION);
      assert.ok(body.topics.includes("security"));
      return Response.json({ id: 99, path_with_namespace: "triombus/peerivo-reviewer", web_url: "https://gitlab.example.com/triombus/peerivo-reviewer", default_branch: "main", cicd_catalog_enabled: true }, { status: 201 });
    }
    if (method === "PUT" && api === "/projects/99") {
      const body = JSON.parse(options.body);
      assert.equal(body.cicd_catalog_enabled, true);
      return Response.json({ id: 99, path_with_namespace: "triombus/peerivo-reviewer", web_url: "https://gitlab.example.com/triombus/peerivo-reviewer", default_branch: "main", cicd_catalog_enabled: true });
    }
    if (method === "GET" && api.startsWith("/projects/99/repository/files/")) return Response.json({ message: "404" }, { status: 404 });
    if (method === "POST" && api.startsWith("/projects/99/repository/files/")) {
      const body = JSON.parse(options.body);
      writes.push({ api, body });
      return Response.json({ file_path: api.split("/").pop(), branch: body.branch }, { status: 201 });
    }
    if (method === "GET" && api === "/projects/99/repository/tags/1.0.0") return Response.json({ message: "404" }, { status: 404 });
    if (method === "POST" && api === "/projects/99/repository/tags") return Response.json({ name: "1.0.0" }, { status: 201 });
    if (method === "GET" && api === "/projects/99/pipelines") return Response.json([]);

    throw new Error(`unexpected GitLab request: ${method} ${url}`);
  };

  const result = await bootstrapGitLabCatalog({
    oauthConfig: config,
    actorUsername: "triombus",
    namespacePath: "triombus",
    assetsRoot: pathToFileURL(path.resolve("gitlab-catalog") + path.sep),
    fetchImpl
  });

  assert.equal(result.projectPath, "triombus/peerivo-reviewer");
  assert.equal(result.catalogEnabled, true);
  assert.equal(result.version, "1.0.0");
  assert.equal(writes.length, 3);
  const component = writes.find(item => decodeURIComponent(item.api).endsWith("/templates/reviewer.yml"));
  assert.ok(component);
  assert.match(component.body.content, /Peerivo Reviewer/);
  assert.match(component.body.content, /v1\/ci\/gitlab\/review/);
});


test("GitLab Catalog bootstrap can transfer the existing catalog project into a branded group namespace", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-gitlab-catalog-transfer-"));
  const db = path.join(dir, "installations.sqlite");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = {
    gitlabBaseUrl: "https://gitlab.example.com", oauthClientId: "client", oauthClientSecret: "secret",
    oauthRedirectUri: "https://reviewer.example.com/oauth/gitlab/callback",
    webhookUrl: "https://reviewer.example.com/webhooks/gitlab", installationsDb: db,
    tokenEncryptionKey: "catalog-test-encryption-key-at-least-32-bytes",
    oauthStateTtlMs: 600000, installSessionTtlMs: 3600000, maxDiscoverProjects: 100, maxInstallProjects: 10
  };
  const store = new GitLabInstallationStore({ filename: db, encryptionKey: config.tokenEncryptionKey });
  store.upsertInstallation({ baseUrl: config.gitlabBaseUrl, userId: 42, username: "triombus",
    accessToken: "access-token", refreshToken: "refresh-token", tokenExpiresAt: Date.now() + 3600000 });
  store.close();

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input)); const method = options.method || "GET";
    const api = url.pathname.replace(/^\/api\/v4/, "");
    if (method === "GET" && api === "/projects/peerivo%2Freviewer") return Response.json({ message:"404" }, { status:404 });
    if (method === "GET" && api === "/projects/triombus%2Fpeerivo-reviewer") {
      return Response.json({ id:99, path_with_namespace:"triombus/peerivo-reviewer" });
    }
    if (method === "PUT" && api === "/projects/99/transfer") {
      assert.deepEqual(JSON.parse(options.body), { namespace:"peerivo" });
      return Response.json({ id:99, path_with_namespace:"peerivo/peerivo-reviewer", web_url:"https://gitlab.example.com/peerivo/peerivo-reviewer", default_branch:"main", cicd_catalog_enabled:true });
    }
    if (method === "PUT" && api === "/projects/99") {
      const body = JSON.parse(options.body);
      if (body.path) {
        assert.deepEqual(body, { path:"reviewer", name:"Peerivo Reviewer" });
        return Response.json({ id:99, path_with_namespace:"peerivo/reviewer", web_url:"https://gitlab.example.com/peerivo/reviewer", default_branch:"main", cicd_catalog_enabled:true });
      }
      return Response.json({ id:99, path_with_namespace:"peerivo/reviewer", web_url:"https://gitlab.example.com/peerivo/reviewer", default_branch:"main", cicd_catalog_enabled:true });
    }
    if (method === "GET" && api.startsWith("/projects/99/repository/files/")) {
      const file = decodeURIComponent(api.split("/").pop().split("?")[0]);
      const source = fs.readFileSync(path.resolve("gitlab-catalog", file), "utf8");
      return Response.json({ content:Buffer.from(source).toString("base64"), last_commit_id:"abc" });
    }
    if (method === "GET" && api === "/projects/99/repository/tags/1.0.3") return Response.json({ name:"1.0.3" });
    if (method === "GET" && api === "/projects/99/pipelines") return Response.json([]);
    throw new Error(`unexpected GitLab request: ${method} ${url}`);
  };

  const result = await bootstrapGitLabCatalog({ oauthConfig:config, actorUsername:"triombus", namespacePath:"peerivo",
    transferFromPath:"triombus/peerivo-reviewer", projectPath:"reviewer", version:"1.0.3",
    assetsRoot:pathToFileURL(path.resolve("gitlab-catalog") + path.sep), fetchImpl });
  assert.equal(result.projectPath, "peerivo/reviewer");
});