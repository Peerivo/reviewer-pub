import crypto from "node:crypto";

const REQUIRED_SCOPES = new Set(["read:user", "write:repository"]);

export class GitVerseOAuthError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "GitVerseOAuthError";
    this.status = status;
  }
}

function parseScopes(value) {
  return new Set(String(value || "").split(/\s+/).map(item => item.trim()).filter(Boolean));
}

function assertScopes(value) {
  const scopes = parseScopes(value);
  for (const required of REQUIRED_SCOPES) {
    if (!scopes.has(required)) throw new GitVerseOAuthError(`GitVerse OAuth grant is missing required scope: ${required}`, 403);
  }
  return [...scopes].sort();
}

async function jsonResponse(response, label) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { throw new GitVerseOAuthError(`${label} returned non-JSON`, 502); }
  if (!response.ok) {
    const detail = typeof body?.error_description === "string"
      ? body.error_description
      : typeof body?.error === "string" ? body.error : "request failed";
    throw new GitVerseOAuthError(`${label} failed (${response.status}): ${detail}`, response.status >= 500 ? 502 : 400);
  }
  return body;
}

function normalizeToken(body, clock, { requireScopes = false } = {}) {
  const accessToken = String(body?.access_token || "");
  const refreshToken = String(body?.refresh_token || "");
  const expiresIn = Number(body?.expires_in);
  if (!accessToken || !refreshToken) throw new GitVerseOAuthError("GitVerse OAuth response is missing tokens");
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new GitVerseOAuthError("GitVerse OAuth response is missing expires_in");
  return {
    accessToken,
    refreshToken,
    tokenExpiresAt: Math.floor(clock() + expiresIn * 1000),
    scopes: requireScopes ? assertScopes(body?.scope) : [...parseScopes(body?.scope)].sort()
  };
}

export function generateGitVersePkceVerifier() {
  return crypto.randomBytes(48).toString("base64url");
}

export function gitversePkceChallenge(verifier) {
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) {
    throw new Error("PKCE verifier must contain 43 to 128 characters");
  }
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export class GitVerseOAuthClient {
  constructor({ webBaseUrl = "https://gitverse.ru", clientId, clientSecret, redirectUri, fetchImpl = fetch, clock = Date.now }) {
    this.webBaseUrl = String(webBaseUrl).replace(/\/$/, "");
    this.clientId = String(clientId);
    this.clientSecret = String(clientSecret);
    this.redirectUri = String(redirectUri);
    this.fetchImpl = fetchImpl;
    this.clock = clock;
  }

  authorizeUrl({ state, codeChallenge }) {
    const url = new URL("/signin/oauth/authorize", this.webBaseUrl);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "read:user write:repository");
    url.searchParams.set("state", String(state));
    url.searchParams.set("code_challenge", String(codeChallenge));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async tokenRequest(parameters, label, options = {}) {
    const response = await this.fetchImpl(new URL("/login/oauth/access_token", this.webBaseUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Peerivo-Reviewer-GitVerse-OAuth/0.5"
      },
      body: new URLSearchParams(parameters),
      redirect: "error"
    });
    return normalizeToken(await jsonResponse(response, label), this.clock, options);
  }

  exchangeCode({ code, verifier }) {
    if (!code) throw new GitVerseOAuthError("GitVerse OAuth callback is missing code", 400);
    return this.tokenRequest({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code_verifier: String(verifier)
    }, "GitVerse OAuth token exchange", { requireScopes: true });
  }

  refresh(refreshToken) {
    if (!refreshToken) throw new GitVerseOAuthError("GitVerse OAuth refresh token is missing", 401);
    return this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: String(refreshToken),
      client_id: this.clientId,
      client_secret: this.clientSecret
    }, "GitVerse OAuth token refresh");
  }
}
