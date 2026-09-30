import test from "node:test";
import assert from "node:assert/strict";
import { createGitLabSelfService } from "../src/gitlab-self-service.mjs";

test("GitLab self-service installs projects, refreshes OAuth and disconnects", async () => {
  let now = Date.parse("2026-09-30T12:00:00Z");
  const calls = [];
  const project = {
    id: 7,
    name: "Widget",
    path_with_namespace: "acme/platform/widget",
    visibility: "private"
  };

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), options });

    if (url.pathname === "/oauth/token") {
      const grant = options.body.get("grant_type");
      if (grant === "authorization_code") {
        return Response.json({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 120,
          created_at: Math.floor(now / 1000)
        });
      }
      assert.equal(grant, "refresh_token");
      assert.equal(options.body.get("refresh_token"), "refresh-1");
      return Response.json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 7200,
        created_at: Math.floor(now / 1000)
      });
    }

    if (url.pathname === "/oauth/revoke") return Response.json({});
    if (url.pathname === "/api/v4/user") return Response.json({ id: 42, username: "alice" });

    if (url.pathname === "/api/v4/projects" && options.method === "GET") {
      return Response.json([project]);
    }

    if (url.pathname === "/api/v4/projects/7/hooks" && options.method === "GET") {
      return Response.json([]);
    }
    if (url.pathname === "/api/v4/projects/7/hooks" && options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(body.url, "https://reviewer.example.com/webhooks/gitlab");
      assert.equal(body.merge_requests_events, true);
      assert.match(body.token, /^pvrwh_/);
      return Response.json({ id: 88, url: body.url, name: body.name }, { status: 201 });
    }
    if (url.pathname === "/api/v4/projects/7/hooks/88" && options.method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    throw new Error(`unexpected request: ${options.method || "GET"} ${url}`);
  };

  const runtime = createGitLabSelfService({
    config: {
      gitlabBaseUrl: "https://gitlab.com",
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
      oauthRedirectUri: "https://reviewer.example.com/oauth/gitlab/callback",
      webhookUrl: "https://reviewer.example.com/webhooks/gitlab",
      installationsDb: ":memory:",
      tokenEncryptionKey: "test-encryption-key-that-is-at-least-32-bytes",
      oauthStateTtlMs: 600_000,
      installSessionTtlMs: 3_600_000,
      maxDiscoverProjects: 100,
      maxInstallProjects: 10
    },
    fetchImpl,
    clock: () => now
  });

  const authorize = new URL(runtime.beginOAuth());
  assert.equal(authorize.origin, "https://gitlab.com");
  assert.equal(authorize.searchParams.get("scope"), "api");
  assert.ok(authorize.searchParams.get("state"));
  assert.ok(authorize.searchParams.get("code_challenge"));

  const completed = await runtime.completeOAuth({
    code: "oauth-code",
    state: authorize.searchParams.get("state")
  });
  assert.equal(completed.username, "alice");

  const selection = await runtime.projectSelection(completed.sessionToken);
  assert.equal(selection.projects.length, 1);
  assert.equal(selection.projects[0].selected, false);

  const applied = await runtime.applyProjects({
    sessionToken: completed.sessionToken,
    csrf: selection.csrf,
    projectIds: ["7"]
  });
  assert.deepEqual(applied.installed, ["acme/platform/widget"]);

  const stored = runtime.store.getProject(7);
  assert.ok(stored.webhookSecret);
  assert.throws(() => runtime.authenticateProjectWebhook({
    projectId: 7,
    repo: "acme/platform/widget",
    tokenHeader: "wrong"
  }), /invalid webhook token/);
  const auth = runtime.authenticateProjectWebhook({
    projectId: 7,
    repo: "acme/platform/widget",
    tokenHeader: stored.webhookSecret
  });
  assert.equal(auth.source, "oauth");

  now += 70_000;
  await runtime.projectSelection(completed.sessionToken);
  const refreshCall = calls.find(call => call.url.endsWith("/oauth/token")
    && call.options.body.get("grant_type") === "refresh_token");
  assert.ok(refreshCall);

  const afterRefreshProjectCall = [...calls].reverse().find(call => call.url.includes("/api/v4/projects?"));
  assert.equal(afterRefreshProjectCall.options.headers.authorization, "Bearer access-2");

  const disconnectSelection = await runtime.projectSelection(completed.sessionToken);
  const disconnected = await runtime.disconnect({
    sessionToken: completed.sessionToken,
    csrf: disconnectSelection.csrf
  });
  assert.equal(disconnected.disconnected, true);
  assert.equal(runtime.store.getProject(7), null);
  assert.equal(runtime.store.getSessionInstallation(completed.sessionToken), null);

  runtime.close();
});
