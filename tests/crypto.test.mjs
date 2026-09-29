import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createAppJwt, verifyWebhookSignature } from "../src/crypto.mjs";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

test("GitHub App JWT binds issuer and a short expiry", () => {
  const now = Date.parse("2026-09-29T00:00:00Z");
  const token = createAppJwt({ appId: "12345", privateKey, now });
  const [header, payload, signature] = token.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, "12345");
  assert.ok(claims.exp - claims.iat <= 540);
  assert.equal(crypto.verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")), true);
});

test("webhook HMAC accepts exact raw bytes and rejects tampering", () => {
  const rawBody = Buffer.from('{"hello":"world"}');
  const secret = "test-secret";
  const signatureHeader = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  assert.equal(verifyWebhookSignature({ secret, rawBody, signatureHeader }), true);
  assert.equal(verifyWebhookSignature({ secret, rawBody: Buffer.from('{"hello":"tampered"}'), signatureHeader }), false);
  assert.equal(verifyWebhookSignature({ secret, rawBody, signatureHeader: "bad" }), false);
});
