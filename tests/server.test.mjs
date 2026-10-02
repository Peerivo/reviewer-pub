import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "../src/server.mjs";

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


test("GitVerse save confirmation shows a clear success state and repository link", async (t) => {
  const gitverseSelfService = {
    async repositorySelection() {
      return {
        login: "olegka85",
        csrf: "csrf-token",
        repositories: [
          {
            id: 356125,
            name: "tesst",
            fullName: "olegka85/tesst",
            visibility: "private",
            selected: true,
            hardGateEnabled: true
          }
        ]
      };
    }
  };

  const server = createServer({
    gitverseOAuthConfig: {},
    gitverseSelfService
  });
  const base = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${base}/gitverse/repositories?updated=1`, {
    headers: { cookie: "peerivo_gitverse_install=test-session" }
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Peerivo Reviewer connected/);
  assert.match(body, /Settings saved/);
  assert.match(body, /olegka85\/tesst/);
  assert.match(body, /https:\/\/gitverse\.ru\/olegka85\/tesst/);
  assert.match(body, /Open repository/);
  assert.match(body, /Manage repositories/);
  assert.match(body, /Block merge on HIGH\/CRITICAL/);
  assert.match(body, /Hard Merge Gate is active for 1/);
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
      hard_gate_all: "1"
    })
  });

  assert.equal(response.status, 303);
  assert.deepEqual(applied.repositoryIds, ["356125"]);
  assert.deepEqual(applied.hardGateRepositoryIds, ["356125"]);
});
