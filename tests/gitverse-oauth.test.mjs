import test from "node:test";
import assert from "node:assert/strict";
import { GitVerseOAuthClient, gitversePkceChallenge } from "../src/gitverse-oauth.mjs";

test("GitVerse OAuth authorization uses required scopes, state and PKCE", () => {
  const verifier = "v".repeat(64);
  const client = new GitVerseOAuthClient({
    webBaseUrl: "https://gitverse.ru",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://reviewer.example.com/oauth/gitverse/callback"
  });
  const url = new URL(client.authorizeUrl({ state: "state", codeChallenge: gitversePkceChallenge(verifier) }));
  assert.equal(url.pathname, "/signin/oauth/authorize");
  assert.equal(url.searchParams.get("scope"), "read:user write:repository");
  assert.equal(url.searchParams.get("state"), "state");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("GitVerse OAuth rejects a grant missing repository write scope", async () => {
  const client = new GitVerseOAuthClient({
    webBaseUrl: "https://gitverse.ru",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://reviewer.example.com/oauth/gitverse/callback",
    fetchImpl: async () => Response.json({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
      scope: "read:user read:repository"
    })
  });
  await assert.rejects(
    () => client.exchangeCode({ code: "gta_code", verifier: "v".repeat(64) }),
    /write:repository/
  );
});

test("GitVerse OAuth refresh rotates access and refresh tokens", async () => {
  const calls = [];
  const client = new GitVerseOAuthClient({
    webBaseUrl: "https://gitverse.ru",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://reviewer.example.com/oauth/gitverse/callback",
    clock: () => 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: options.body });
      return Response.json({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600
      });
    }
  });
  const token = await client.refresh("refresh-1");
  assert.equal(token.accessToken, "access-2");
  assert.equal(token.refreshToken, "refresh-2");
  assert.equal(token.tokenExpiresAt, 3_601_000);
  assert.equal(calls[0].body.get("grant_type"), "refresh_token");
});


test("GitVerse OAuth accepts comma-delimited granted scopes", async () => {
  const client = new GitVerseOAuthClient({
    webBaseUrl: "https://gitverse.ru",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://reviewer.example.com/oauth/gitverse/callback",
    fetchImpl: async () => Response.json({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
      scope: "read:user,write:repository"
    })
  });
  const token = await client.exchangeCode({ code: "gta_code", verifier: "v".repeat(64) });
  assert.deepEqual(token.scopes, ["read:user", "write:repository"]);
});

test("GitVerse OAuth treats write:user as satisfying read:user", async () => {
  const client = new GitVerseOAuthClient({
    webBaseUrl: "https://gitverse.ru",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://reviewer.example.com/oauth/gitverse/callback",
    fetchImpl: async () => Response.json({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
      scope: "write:user write:repository"
    })
  });
  const token = await client.exchangeCode({ code: "gta_code", verifier: "v".repeat(64) });
  assert.deepEqual(token.scopes, ["write:repository", "write:user"]);
});


test("GitVerse OAuth accepts omitted scope field and defers capability proof to API calls", async () => {
  const client = new GitVerseOAuthClient({
    webBaseUrl: "https://gitverse.ru",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://reviewer.example.com/oauth/gitverse/callback",
    fetchImpl: async () => Response.json({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600
    })
  });
  const token = await client.exchangeCode({ code: "gta_code", verifier: "v".repeat(64) });
  assert.deepEqual(token.scopes, []);
});

test("GitVerse OAuth accepts scopes array variant", async () => {
  const client = new GitVerseOAuthClient({
    webBaseUrl: "https://gitverse.ru",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://reviewer.example.com/oauth/gitverse/callback",
    fetchImpl: async () => Response.json({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
      scopes: ["read:user", "write:repository"]
    })
  });
  const token = await client.exchangeCode({ code: "gta_code", verifier: "v".repeat(64) });
  assert.deepEqual(token.scopes, ["read:user", "write:repository"]);
});
