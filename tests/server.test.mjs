import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "../src/server.mjs";
import { installationFixture } from "./installation-fixtures.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("landing and health start before provider credentials are provisioned", async (t) => {
  const server = createServer();
  const base = await listen(server);
  t.after(() => server.close());

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: "peerivo-reviewer-integrations",
    version: "0.5.0"
  });

  const landing = await fetch(base);
  assert.equal(landing.status, 200);
  const body = await landing.text();
  assert.match(body, /Peerivo Reviewer/);
  assert.match(body, /Connect GitLab/);
  assert.match(body, /Connect GitVerse/);
});

test("GitLab OAuth connect route fails closed before OAuth configuration exists", async (t) => {
  const server = createServer({ gitlabOAuthConfig: null });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/connect/gitlab`, { redirect: "manual" });
  assert.equal(response.status, 503);
});

test("GitVerse OAuth connect route fails closed before OAuth configuration exists", async (t) => {
  const server = createServer({ gitverseOAuthConfig: null });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/connect/gitverse`, { redirect: "manual" });
  assert.equal(response.status, 503);
});

test("webhook fails closed when runtime secrets are not configured", async (t) => {
  const server = createServer();
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": "sha256=" + "0".repeat(64)
    },
    body: "{}"
  });

  assert.equal(response.status, 503);
});

test("GitLab webhook fails closed when runtime secrets are not configured", async (t) => {
  const server = createServer();
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/webhooks/gitlab`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-event": "Merge Request Hook",
      "x-gitlab-token": "not-configured"
    },
    body: "{}"
  });

  assert.equal(response.status, 503);
});


test("GitVerse save confirmation uses persisted installation verification and keeps promo controls", async (t) => {
  const fixture = installationFixture("gitverse");
  fixture.service.store.setHardGate(7, { enabled: true, token: "test-gate-token-at-least-32-bytes-long", branch: "main" });
  const server = createServer({ gitverseOAuthConfig: fixture.config, gitverseSelfService: fixture.service });
  const base = await listen(server);
  t.after(() => { server.close(); fixture.service.close(); });
  const response = await fetch(`${base}/gitverse/repositories?updated=1`, { headers: { cookie: fixture.cookie } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Peerivo Reviewer connected/);
  assert.match(body, /Settings saved/);
  assert.match(body, /alice\/widget/);
  assert.match(body, /https:\/\/gitverse\.ru\/alice\/widget/);
  assert.match(body, /Open project/);
  assert.match(body, /Manage projects/);
  assert.match(body, /Block merge on HIGH\/CRITICAL/);
  assert.match(body, /Promo code/);
  assert.match(body, /free trial automatically/);
});

test("GitVerse repository save enables hard gate for every selected repository", async (t) => {
  let applied = null;
  const gitverseSelfService = {
    async applyRepositories(input) {
      applied = input;
      return { selectedCount: input.repositoryIds.length, hardGateCount: input.hardGateRepositoryIds.length };
    }
  };

  const server = createServer({
    gitverseOAuthConfig: {},
    gitverseSelfService
  });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/gitverse/repositories`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: "peerivo_gitverse_install=test-session"
    },
    body: new URLSearchParams({
      csrf: "csrf-token",
      repository: "356125",
      hard_gate_all: "1",
      promo_code: "GITVERSE-GIFT"
    })
  });

  assert.equal(response.status, 303);
  assert.deepEqual(applied.repositoryIds, ["356125"]);
  assert.deepEqual(applied.hardGateRepositoryIds, ["356125"]);
  assert.equal(applied.promoCode, "GITVERSE-GIFT");
});


test("GitVerse save redirects to trial success when a trial is provisioned", async (t) => {
  const gitverseSelfService = {
    async applyRepositories() {
      return {
        selectedCount: 1,
        hardGateCount: 0,
        access: [{ repositoryId: 356125, mode: "trial", plan: "starter" }]
      };
    }
  };

  const server = createServer({
    gitverseOAuthConfig: {},
    gitverseSelfService
  });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/gitverse/repositories`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: "peerivo_gitverse_install=test-session"
    },
    body: new URLSearchParams({
      csrf: "csrf-token",
      repository: "356125"
    })
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/gitverse/connected");
});

test("GitVerse promo errors return the user to a useful installer state", async (t) => {
  const gitverseSelfService = {
    async applyRepositories() {
      throw Object.assign(new Error("promo code is invalid or unavailable"), {
        status: 404,
        code: "promo_invalid"
      });
    }
  };

  const server = createServer({
    gitverseOAuthConfig: {},
    gitverseSelfService
  });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/gitverse/repositories`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: "peerivo_gitverse_install=test-session"
    },
    body: new URLSearchParams({
      csrf: "csrf-token",
      repository: "356125",
      promo_code: "BAD-PROMO-CODE"
    })
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/gitverse/repositories?error=promo_invalid");
});
