import test from "node:test";
import assert from "node:assert/strict";
import { createGitVerseSelfService } from "../src/gitverse-self-service.mjs";

test("GitVerse self-service connects repositories, refreshes tokens and disconnects", async () => {
  let now = Date.parse("2026-09-30T12:00:00Z");
  const calls = [];
  let workflowInstalled = false;
  let gateSecretInstalled = false;
  const workflowSha = "a".repeat(40);
  const repository = {
    id: 77,
    name: "demo",
    full_name: "peerivo/demo",
    visibility: "private",
    archived: false,
    disabled: false,
    default_branch: "master",
    permissions: { pull: true, push: true, admin: true }
  };

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), options });

    if (url.origin === "https://gitverse.ru" && url.pathname === "/login/oauth/access_token") {
      const grant = options.body.get("grant_type");
      if (grant === "authorization_code") {
        return Response.json({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 120,
          scope: "read:user write:repository"
        });
      }
      assert.equal(options.body.get("refresh_token"), "refresh-1");
      return Response.json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
        scope: "read:user write:repository"
      });
    }

    if (url.pathname === "/user") return Response.json({ id: 42, login: "oleg" });
    if (url.pathname === "/user/repos") return Response.json([{
      ...repository,
      permissions: undefined
    }]);
    if (url.pathname === "/repos/peerivo/demo" && (options.method || "GET") === "GET") {
      return Response.json(repository);
    }
    if (url.pathname === "/repos/peerivo/demo/hooks" && options.method === "GET") return Response.json([]);
    if (url.pathname === "/repos/peerivo/demo/hooks" && options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.events, ["pull_request"]);
      assert.equal(body.config.url, "https://reviewer.example.com/webhooks/gitverse/77");
      assert.match(body.config.authorization_header, /^Bearer pvrwh_/);
      return Response.json({ id: 88, active: true, events: body.events, config: body.config }, { status: 201 });
    }
    if (url.pathname === "/repos/peerivo/demo/hooks/88" && options.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/peerivo/demo/actions/secrets/PEERIVO_GATE_TOKEN" && options.method === "PUT") {
      const value = url.searchParams.get("value");
      assert.match(value, /^pvrci_/);
      gateSecretInstalled = true;
      return Response.json({ name: "PEERIVO_GATE_TOKEN" }, { status: 201 });
    }
    if (url.pathname === "/repos/peerivo/demo/actions/secrets/PEERIVO_GATE_TOKEN" && options.method === "DELETE") {
      assert.equal(gateSecretInstalled, true);
      gateSecretInstalled = false;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/repos/peerivo/demo/contents/.gitverse/workflows/reviewer.yml" && (options.method || "GET") === "GET") {
      if (!workflowInstalled) return Response.json({ message: "not found" }, { status: 404 });
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from("installed", "utf8").toString("base64"),
        sha: workflowSha
      });
    }
    if (url.pathname === "/repos/peerivo/demo/contents/.gitverse/workflows/reviewer.yml" && options.method === "PUT") {
      const body = JSON.parse(options.body);
      assert.equal(body.branch, "master");
      assert.match(Buffer.from(body.content, "base64").toString("utf8"), /PEERIVO_GATE_TOKEN/);
      workflowInstalled = true;
      return Response.json({ content: { sha: workflowSha } });
    }
    if (url.pathname === "/repos/peerivo/demo/contents/.gitverse/workflows/reviewer.yml" && options.method === "DELETE") {
      const body = JSON.parse(options.body);
      assert.equal(body.branch, "master");
      assert.equal(body.sha, workflowSha);
      workflowInstalled = false;
      return Response.json({ content: null });
    }

    throw new Error(`unexpected request: ${options.method || "GET"} ${url}`);
  };

  const runtime = createGitVerseSelfService({
    config: {
      webBaseUrl: "https://gitverse.ru",
      apiBaseUrl: "https://api.gitverse.ru",
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
      oauthRedirectUri: "https://reviewer.example.com/oauth/gitverse/callback",
      webhookUrl: "https://reviewer.example.com/webhooks/gitverse",
      installationsDb: ":memory:",
      tokenEncryptionKey: "gitverse-test-encryption-key-at-least-32-bytes",
      oauthStateTtlMs: 600000,
      installSessionTtlMs: 3600000,
      maxDiscoverRepositories: 100,
      maxInstallRepositories: 10
    },
    fetchImpl,
    clock: () => now
  });

  const authorize = new URL(runtime.beginOAuth());
  assert.equal(authorize.pathname, "/signin/oauth/authorize");
  assert.equal(authorize.searchParams.get("scope"), "read:user write:repository");

  const completed = await runtime.completeOAuth({
    code: "gta_code",
    state: authorize.searchParams.get("state")
  });
  assert.equal(completed.login, "oleg");

  const selection = await runtime.repositorySelection(completed.sessionToken);
  assert.equal(selection.repositories.length, 1);
  assert.equal(selection.repositories[0].fullName, "peerivo/demo");

  const applied = await runtime.applyRepositories({
    sessionToken: completed.sessionToken,
    csrf: selection.csrf,
    repositoryIds: ["77"],
    hardGateRepositoryIds: ["77"]
  });
  assert.deepEqual(applied.installed, ["peerivo/demo"]);
  assert.equal(applied.hardGateCount, 1);
  assert.equal(workflowInstalled, true);
  assert.equal(gateSecretInstalled, true);

  const stored = runtime.store.getRepository(77);
  assert.equal(stored.hardGateEnabled, true);
  assert.equal(stored.hardGateBranch, "master");
  assert.match(stored.hardGateToken, /^pvrci_/);
  const ciAuth = runtime.authenticateCiGate({ fullName: "peerivo/demo", token: stored.hardGateToken });
  assert.equal(ciAuth.repositoryId, 77);
  assert.throws(
    () => runtime.authenticateCiGate({ fullName: "peerivo/demo", token: "wrong" }),
    /invalid GitVerse hard-gate token/
  );
  assert.throws(() => runtime.authenticateRepositoryWebhook({
    repositoryId: 77,
    authorizationHeader: "Bearer wrong"
  }), /invalid webhook authorization/);
  const auth = runtime.authenticateRepositoryWebhook({
    repositoryId: 77,
    authorizationHeader: `Bearer ${stored.webhookSecret}`
  });
  assert.equal(auth.repositoryId, 77);

  now += 70000;
  await runtime.repositorySelection(completed.sessionToken);
  assert.ok(calls.some(call =>
    call.url === "https://gitverse.ru/login/oauth/access_token"
    && call.options.body.get("grant_type") === "refresh_token"
  ));
  const lastRepos = [...calls].reverse().find(call => new URL(call.url).pathname === "/user/repos");
  assert.equal(lastRepos.options.headers.authorization, "Bearer access-2");

  const disconnectSelection = await runtime.repositorySelection(completed.sessionToken);
  const disconnected = await runtime.disconnect({
    sessionToken: completed.sessionToken,
    csrf: disconnectSelection.csrf
  });
  assert.equal(disconnected.disconnected, true);
  assert.ok(disconnected.warnings.some(item => /OAuth grant remains valid/.test(item)));
  assert.equal(workflowInstalled, false);
  assert.equal(gateSecretInstalled, false);
  assert.equal(runtime.store.getRepository(77), null);

  runtime.close();
});
