import test from "node:test";
import assert from "node:assert/strict";
import { GitVerseInstallationStore } from "../src/gitverse-installations.mjs";

test("GitVerse installation store protects state, sessions and webhook secrets", () => {
  let now = Date.parse("2026-09-30T12:00:00Z");
  const store = new GitVerseInstallationStore({
    filename: ":memory:",
    encryptionKey: "gitverse-test-encryption-key-at-least-32-bytes",
    clock: () => now
  });

  const state = store.createOAuthState({ verifier: "v".repeat(64), ttlMs: 60000 });
  assert.equal(store.consumeOAuthState(state), "v".repeat(64));
  assert.throws(() => store.consumeOAuthState(state), /invalid or expired/);

  const installation = store.upsertInstallation({
    userId: 42,
    login: "oleg",
    accessToken: "access",
    refreshToken: "refresh",
    tokenExpiresAt: now + 3600000
  });
  const session = store.createSession(installation.id, { ttlMs: 60000 });
  const csrf = store.csrfToken(session);
  assert.equal(store.verifyCsrf(session, csrf), true);

  store.upsertRepository({
    repositoryId: 77,
    installationId: installation.id,
    fullName: "peerivo/demo",
    webhookId: 88,
    webhookSecret: "gitverse-webhook-secret-at-least-32-bytes"
  });
  assert.equal(store.getRepository(77).fullName, "peerivo/demo");
  assert.equal(store.getRepository(77).webhookSecret, "gitverse-webhook-secret-at-least-32-bytes");

  now += 60001;
  assert.equal(store.getSessionInstallation(session), null);
  store.close();
});
