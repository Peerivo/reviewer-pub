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
