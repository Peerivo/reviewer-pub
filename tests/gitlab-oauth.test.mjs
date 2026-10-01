import test from "node:test";
import assert from "node:assert/strict";
import { GitLabOAuthClient, pkceChallenge } from "../src/gitlab-oauth.mjs";

test("GitLab OAuth authorization uses confidential server-side code flow", () => {
  const verifier = "ks02i3jdikdo2k0dkfodf3m39rjfjsdk0wk349rj3jrhf";
  assert.equal(pkceChallenge(verifier), "2i0WFA-0AerkjQm4X4oDEhqA17QIAKNjXpagHBXmO_U");

  const client = new GitLabOAuthClient({
    baseUrl: "https://gitlab.com",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://reviewer.example.com/oauth/gitlab/callback"
  });
  const url = new URL(client.authorizeUrl({ state: "state-token", codeChallenge: pkceChallenge(verifier) }));
  assert.equal(url.origin, "https://gitlab.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "api");
  assert.equal(url.searchParams.get("state"), "state-token");
  assert.equal(url.searchParams.get("code_challenge"), null);
  assert.equal(url.searchParams.get("code_challenge_method"), null);
});

test("GitLab OAuth exchanges and rotates refresh tokens", async () => {
  const calls = [];
  const responses = [
    { access_token: "access-1", refresh_token: "refresh-1", expires_in: 7200, created_at: 1000 },
    { access_token: "access-2", refresh_token: "refresh-2", expires_in: 7200, created_at: 2000 }
  ];
  const client = new GitLabOAuthClient({
    baseUrl: "https://gitlab.example.com",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://reviewer.example.com/oauth/gitlab/callback",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const first = await client.exchangeCode({ code: "code-1" });
  assert.equal(first.accessToken, "access-1");
  assert.equal(first.tokenExpiresAt, 8_200_000);
  const firstBody = calls[0].options.body;
  assert.equal(firstBody.get("grant_type"), "authorization_code");
  assert.equal(firstBody.get("code_verifier"), null);
  assert.equal(firstBody.get("client_secret"), "client-secret");

  const second = await client.refresh("refresh-1");
  assert.equal(second.accessToken, "access-2");
  assert.equal(second.refreshToken, "refresh-2");
  const secondBody = calls[1].options.body;
  assert.equal(secondBody.get("grant_type"), "refresh_token");
  assert.equal(secondBody.get("refresh_token"), "refresh-1");
  assert.equal(secondBody.get("client_secret"), "client-secret");
});
