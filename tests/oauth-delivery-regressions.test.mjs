import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadGitLabOAuthConfig, loadGitVerseOAuthConfig } from "../src/config.mjs";
import { createServer } from "../src/server.mjs";
import { installationFixture } from "./installation-fixtures.mjs";

const providers = [
  { name: "gitlab", prefix: "GITLAB", load: loadGitLabOAuthConfig, manage: "/gitlab/projects", field: "project", apply: "applyProjects", select: "projectSelection", option: "gitlabSelfService", config: "gitlabOAuthConfig", label: "Save GitLab projects" },
  { name: "gitverse", prefix: "GITVERSE", load: loadGitVerseOAuthConfig, manage: "/gitverse/repositories", field: "repository", apply: "applyRepositories", select: "repositorySelection", option: "gitverseSelfService", config: "gitverseOAuthConfig", label: "Save GitVerse repositories" },
];
function env(provider, publicUrl) {
  const p = provider.prefix;
  return { [`${p}_PUBLIC_URL`]: publicUrl, [`${p}_OAUTH_CLIENT_ID`]: "synthetic-client",
    [`${p}_OAUTH_CLIENT_SECRET`]: "synthetic-secret", [`${p}_TOKEN_ENCRYPTION_KEY`]: "synthetic-only-encryption-key-32-bytes-long",
    [`${p}_INSTALLATIONS_DB`]: ":memory:", REVIEWER_API_URL: "https://reviewer.example.test", REVIEWER_API_TOKEN: "synthetic-reviewer-token" };
}
async function listen(t, provider, service) {
  const server = createServer({ [provider.config]: service.fixtureConfig || {}, [provider.option]: service });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
function selection(provider, selected) {
  if (provider.name === "gitlab") return { username: "fixture-user", csrf: "fixture-csrf", projects: [
    { id: 7, name: "Fixture project", pathWithNamespace: "fixture/project", visibility: "private", selected },
  ] };
  return { login: "fixture-user", csrf: "fixture-csrf", repositories: [
    { id: 7, name: "Fixture repository", fullName: "fixture/project", visibility: "private", selected, hardGateEnabled: false },
  ] };
}

for (const provider of providers) {
  for (const url of [
    "https://localhost", "https://LOCALHOST.", "https://auth.localhost", "https://localhost.localdomain",
    "https://127.0.0.1", "https://127.12.34.56", "https://2130706433", "https://0x7f000001",
    "https://0.0.0.0:3000", "https://[::1]", "https://[::]", "https://[::ffff:127.0.0.1]",
    "https://host.docker.internal", "https://gateway.docker.internal",
  ]) {
    test(`${provider.name}: published OAuth config rejects local/container callback base ${url}`, () => {
      assert.throws(() => provider.load(env(provider, url)), /public.*(?:host|URL)|local|loopback|container/i);
    });
  }
  test(`${provider.name}: valid public base generates matching HTTPS callback and webhook`, () => {
    const config = provider.load(env(provider, "https://pub.reviewer.example.test/"));
    assert.equal(config.oauthRedirectUri, `https://pub.reviewer.example.test/oauth/${provider.name}/callback`);
    assert.equal(config.webhookUrl, `https://pub.reviewer.example.test/webhooks/${provider.name}`);
    assert.equal(new URL(config.oauthRedirectUri).hostname, new URL(config.webhookUrl).hostname);
  });
  test(`${provider.name}: public domain containing the word localhost remains valid`, () => {
    assert.doesNotThrow(() => provider.load(env(provider, "https://localhost.example.test")));
  });
  test(`${provider.name}: cancelled OAuth cannot create a session or success redirect`, async t => {
    let exchanged = false;
    const base = await listen(t, provider, { completeOAuth() { exchanged = true; throw new Error("must not exchange"); } });
    const response = await fetch(`${base}/oauth/${provider.name}/callback?error=access_denied`, { redirect: "manual" });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(exchanged, false);
  });
  test(`${provider.name}: successful OAuth returns to management with a protected session cookie`, async t => {
    let received;
    const base = await listen(t, provider, { store: { listProjects() { return []; }, listRepositories() { return []; } }, async completeOAuth(input) { received = input; return { sessionToken: "synthetic-session", installationId: 1 }; } });
    const response = await fetch(`${base}/oauth/${provider.name}/callback?code=fixture-code&state=fixture-state`, { redirect: "manual" });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), provider.manage);
    assert.deepEqual(received, { code: "fixture-code", state: "fixture-state" });
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/i); assert.match(cookie, /Secure/i); assert.match(cookie, /SameSite=Lax/i);
  });
  test(`${provider.name}: POST save, confirmation GET and fresh GET preserve selected input`, async t => {
    const f = installationFixture(provider.name, { installed: false });
    t.after(() => f.service.close());
    f.service.fixtureConfig = f.config;
    const base = await listen(t, provider, f.service);
    const response = await fetch(base + provider.manage, { method: "POST", redirect: "manual", headers: { cookie: f.cookie }, body: new URLSearchParams({ csrf: f.csrf, [provider.field]: "7" }) });
    assert.equal(response.status, 303);
    const next = response.headers.get("location");
    assert.equal(next, provider.name === "gitlab" ? provider.manage : `/${provider.name}/connected`);
    const confirmation = await fetch(base + next, { headers: { cookie: f.cookie } });
    assert.equal(confirmation.status, 200);
    assert.match(await confirmation.text(), /data-state="connected"/);
    for (const target of [provider.manage + "?updated=1", provider.manage]) {
      const page = await fetch(base + target, { headers: { cookie: f.cookie } });
      assert.equal(page.status, 200);
      const html = await page.text();
      if (provider.name === "gitlab") {
        assert.match(html, /operation" value="remove"/);
        assert.match(html, /Connected repositories|Подключённые репозитории/);
        assert.match(html, /data-repo-search/);
        assert.doesNotMatch(html, /Save and verify connection/);
      } else {
        assert.match(html, new RegExp(`name="${provider.field}"[^>]*value="7"[^>]*checked`));
        assert.ok(html.includes("Save and verify connection"));
      }
      assert.match(html, /data-testid="connection-banner" data-state="connected"/);
      assert.match(page.headers.get("cache-control"), /no-store/);
    }
  });
  test(`${provider.name}: provider save failure does not redirect to successful confirmation`, async t => {
    const base = await listen(t, provider, { async [provider.apply]() { throw Object.assign(new Error("fixture provider unavailable"), { status: 502 }); } });
    const response = await fetch(base + provider.manage, { method: "POST", redirect: "manual", body: new URLSearchParams({ csrf: "fixture-csrf", [provider.field]: "7" }) });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("location"), null);
  });
  test(`${provider.name}: an expired management session is not a successful installation page`, async t => {
    const base = await listen(t, provider, { async [provider.select]() { throw Object.assign(new Error("fixture expired session"), { status: 401 }); } });
    const response = await fetch(base + provider.manage, { redirect: "manual" });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("location"), null);
    assert.doesNotMatch(await response.text(), /Settings saved|installation updated|Reviewer connected/);
  });
}
