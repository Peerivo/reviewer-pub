import crypto from "node:crypto";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createAppJwt({ appId, privateKey, now = Date.now() }) {
  const issuedAt = Math.floor(now / 1000) - 30;
  const payload = {
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: String(appId)
  };
  const encodedHeader = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function verifyWebhookSignature({ secret, rawBody, signatureHeader }) {
  if (typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256=")) return false;
  const suppliedHex = signatureHeader.slice(7);
  if (!/^[0-9a-f]{64}$/i.test(suppliedHex)) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(suppliedHex, "hex");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export function verifySharedSecret({ secret, supplied }) {
  if (typeof secret !== "string" || !secret || typeof supplied !== "string" || !supplied) return false;
  const expected = crypto.createHash("sha256").update(secret).digest();
  const actual = crypto.createHash("sha256").update(supplied).digest();
  return crypto.timingSafeEqual(expected, actual);
}
