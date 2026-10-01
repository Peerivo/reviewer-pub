import crypto from "node:crypto";

export class GitLabOAuthError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "GitLabOAuthError";
    this.status = status;
  }
}

function tokenExpiry(body, clock) {
  const expiresIn = Number(body?.expires_in);
  const createdAtSeconds = Number(body?.created_at);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new GitLabOAuthError("GitLab OAuth response is missing expires_in");
  const createdAt = Number.isFinite(createdAtSeconds) && createdAtSeconds > 0
    ? createdAtSeconds * 1000
    : clock();
  return Math.floor(createdAt + expiresIn * 1000);
}

function normalizeToken(body, clock) {
  const accessToken = String(body?.access_token || "");
  const refreshToken = String(body?.refresh_token || "");
  if (!accessToken || !refreshToken) throw new GitLabOAuthError("GitLab OAuth response is missing tokens");
  return {
    accessToken,
    refreshToken,
    tokenExpiresAt: tokenExpiry(body, clock)
  };
}

async function jsonResponse(response, label) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new GitLabOAuthError(`${label} returned non-JSON`, 502);
  }
  if (!response.ok) {
    const detail = typeof body?.error_description === "string"
      ? body.error_description
      : typeof body?.error === "string"
        ? body.error
        : "request failed";
    throw new GitLabOAuthError(`${label} failed (${response.status}): ${detail}`, response.status >= 500 ? 502 : 400);
  }
  return body;
}

export function generatePkceVerifier() {
  return crypto.randomBytes(48).toString("base64url");
}

export function pkceChallenge(verifier) {
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) {
    throw new Error("PKCE verifier must contain 43 to 128 characters");
  }
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export class GitLabOAuthClient {
  constructor({ baseUrl, clientId, clientSecret, redirectUri, fetchImpl = fetch, clock = Date.now }) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.clientId = String(clientId);
    this.clientSecret = String(clientSecret);
    this.redirectUri = String(redirectUri);
    this.fetchImpl = fetchImpl;
    this.clock = clock;
  }

  authorizeUrl({ state, codeChallenge }) {
    const url = new URL("/oauth/authorize", this.baseUrl);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", String(state));
    url.searchParams.set("scope", "api");
    url.searchParams.set("code_challenge", String(codeChallenge));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async tokenRequest(parameters, label) {
    const response = await this.fetchImpl(new URL("/oauth/token", this.baseUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Peerivo-Reviewer-GitLab-OAuth/0.5"
      },
      body: new URLSearchParams(parameters),
      redirect: "error"
    });
    return normalizeToken(await jsonResponse(response, label), this.clock);
  }

  exchangeCode({ code, verifier }) {
    if (!code) throw new GitLabOAuthError("GitLab OAuth callback is missing code", 400);
    return this.tokenRequest({
      client_id: this.clientId,
      code: String(code),
      grant_type: "authorization_code",
      redirect_uri: this.redirectUri,
      code_verifier: String(verifier)
    }, "GitLab OAuth token exchange");
  }

  refresh(refreshToken) {
    if (!refreshToken) throw new GitLabOAuthError("GitLab OAuth refresh token is missing", 401);
    return this.tokenRequest({
      client_id: this.clientId,
      refresh_token: String(refreshToken),
      grant_type: "refresh_token",
      redirect_uri: this.redirectUri
    }, "GitLab OAuth token refresh");
  }

  async revoke(token) {
    if (!token) return;
    const response = await this.fetchImpl(new URL("/oauth/revoke", this.baseUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Peerivo-Reviewer-GitLab-OAuth/0.5"
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        token: String(token)
      }),
      redirect: "error"
    });
    if (!response.ok) throw new GitLabOAuthError(`GitLab OAuth revoke failed (${response.status})`, response.status >= 500 ? 502 : 400);
  }
}
