import test from "node:test";
import assert from "node:assert/strict";
import { GitLabInstallationStore } from "../src/gitlab-installations.mjs";

test("GitLab installation store consumes OAuth state once and expires sessions", () => {
  let now = Date.parse("2026-09-30T12:00:00Z");
  const store = new GitLabInstallationStore({
    filename: ":memory:",
    encryptionKey: "test-encryption-key-that-is-at-least-32-bytes",
    clock: () => now
  });

  const verifier = "v".repeat(64);
  const state = store.createOAuthState({ verifier, ttlMs: 60_000 });
  assert.equal(store.consumeOAuthState(state), verifier);
  assert.throws(() => store.consumeOAuthState(state), /invalid or expired OAuth state/);

  const installation = store.upsertInstallation({
    baseUrl: "https://gitlab.com",
    userId: 42,
    username: "alice",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    tokenExpiresAt: now + 7_200_000
  });
  assert.equal(installation.accessToken, "access-secret");
  assert.equal(installation.refreshToken, "refresh-secret");

  const session = store.createSession(installation.id, { ttlMs: 60_000 });
  assert.equal(store.getSessionInstallation(session).username, "alice");
  const csrf = store.csrfToken(session);
  assert.equal(store.verifyCsrf(session, csrf), true);
  assert.equal(store.verifyCsrf(session, csrf + "x"), false);

  now += 60_001;
  assert.equal(store.getSessionInstallation(session), null);
  store.close();
});

test("GitLab installation store binds projects to one installation", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const store = new GitLabInstallationStore({
    filename: ":memory:",
    encryptionKey: "another-test-encryption-key-at-least-32-bytes",
    clock: () => now
  });
  const installation = store.upsertInstallation({
    baseUrl: "https://gitlab.com",
    userId: 7,
    username: "maintainer",
    accessToken: "access",
    refreshToken: "refresh",
    tokenExpiresAt: now + 7_200_000
  });

  store.upsertProject({
    projectId: 99,
    installationId: installation.id,
    pathWithNamespace: "acme/security/widget",
    webhookId: 123,
    webhookSecret: "webhook-secret-that-is-at-least-32-bytes"
  });

  const project = store.getProject(99);
  assert.equal(project.pathWithNamespace, "acme/security/widget");
  assert.equal(project.webhookId, 123);
  assert.equal(project.webhookSecret, "webhook-secret-that-is-at-least-32-bytes");
  assert.deepEqual(store.listProjects(installation.id).map(item => item.projectId), [99]);

  store.deleteProject(99);
  assert.equal(store.getProject(99), null);
  store.close();
});
