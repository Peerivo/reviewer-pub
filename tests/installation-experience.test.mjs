import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../src/server.mjs';
import { connectedPage, uiLanguage } from '../src/installation-ui.mjs';
import { installationFixture } from './installation-fixtures.mjs';

async function setup(t, provider, options) {
  const f = installationFixture(provider, options);
  const server = createServer(provider === 'gitlab' ? { gitlabOAuthConfig: f.config, gitlabSelfService: f.service } : { gitverseOAuthConfig: f.config, gitverseSelfService: f.service });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); f.service.close(); });
  return { ...f, base: `http://127.0.0.1:${server.address().port}`, manage: provider === 'gitlab' ? '/gitlab/projects' : '/gitverse/repositories' };
}

for (const provider of ['gitlab', 'gitverse']) {
  test(`${provider}: saving redirects to a verified result, not back to the selection form`, async t => {
    const f = await setup(t, provider, { installed: false });
    const response = await fetch(f.base + f.manage, { method: 'POST', redirect: 'manual', headers: { cookie: f.cookie }, body: new URLSearchParams({ csrf: f.csrf, [provider === 'gitlab' ? 'project' : 'repository']: '7' }) });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), `/${provider}/connected`);
    const verifyStart = f.calls.length;
    const result = await fetch(f.base + response.headers.get('location'), { headers: { cookie: f.cookie } });
    const body = await result.text();
    assert.equal(result.status, 200);
    assert.match(body, /data-state="connected"/);
    assert.match(body, /Access and webhook verified/);
    assert.match(body, /Open project/);
    assert.match(body, /not the code or the overall CI result/);
    assert.ok(f.calls.slice(verifyStart).some(call => call.path.includes('/hooks')));
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(body, /NEVER-EXPOSE/);
  });
  test(`${provider}: banner persists on management reload without any success query string`, async t => {
    const f = await setup(t, provider);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(f.base + f.manage, { headers: { cookie: f.cookie } });
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.match(body, /data-testid="connection-banner" data-state="connected"/);
      assert.match(body, /Save and verify connection/);
      assert.match(body, /Check connection again/);
    }
  });
  test(`${provider}: fake success query cannot fabricate a green banner`, async t => {
    const f = await setup(t, provider, { installed: false });
    const body = await (await fetch(f.base + f.manage + '?updated=1&access=active', { headers: { cookie: f.cookie } })).text();
    assert.match(body, /data-state="empty"/);
    assert.doesNotMatch(body, /data-state="connected"/);
  });
  test(`${provider}: expired session gets a useful error page and a reconnection action`, async t => {
    const f = await setup(t, provider);
    const response = await fetch(f.base + `/${provider}/connected`, { headers: { cookie: 'unknown=value', 'accept-language': 'ru' } });
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.match(body, /Сессия управления истекла/);
    assert.match(body, /Подключить заново/);
    assert.match(body, /role="alert"/);
  });
  test(`${provider}: reconnect entry reuses a valid installation, explicit reauthorization still works`, async t => {
    const f = await setup(t, provider);
    const response = await fetch(f.base + `/connect/${provider}`, { redirect: 'manual', headers: { cookie: f.cookie } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), `/${provider}/connected`);
    const auth = await fetch(f.base + `/connect/${provider}?reauthorize=1`, { redirect: 'manual', headers: { cookie: f.cookie } });
    assert.equal(auth.status, 302);
    assert.equal(new URL(auth.headers.get('location')).pathname, provider === 'gitlab' ? '/oauth/authorize' : '/signin/oauth/authorize');
  });
  test(`${provider}: failed save does not redirect to success or expose provider text`, async t => {
    const f = await setup(t, provider);
    f.mode.httpStatus = 500;
    const response = await fetch(f.base + f.manage, { method: 'POST', redirect: 'manual', headers: { cookie: f.cookie }, body: new URLSearchParams({ csrf: f.csrf, [provider === 'gitlab' ? 'project' : 'repository']: '7' }) });
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.match(body, /Connection could not be completed/);
    assert.doesNotMatch(body, /NEVER-EXPOSE|data-state="connected"/);
  });
  test(`${provider}: CSRF failure is not a license error or a success`, async t => {
    const f = await setup(t, provider);
    const response = await fetch(f.base + f.manage, { method: 'POST', redirect: 'manual', headers: { cookie: f.cookie }, body: new URLSearchParams({ csrf: 'wrong', [provider === 'gitlab' ? 'project' : 'repository']: '7' }) });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('location'), null);
    assert.match(await response.text(), /operation was not authorized/);
  });
  test(`${provider}: a removed webhook becomes a persistent red banner instead of disappearing`, async t => {
    const f = await setup(t, provider); f.hooks.clear();
    const body = await (await fetch(f.base + f.manage, { headers: { cookie: f.cookie, 'accept-language': 'ru' } })).text();
    assert.match(body, /data-state="attention"/);
    assert.match(body, /Подключение требует внимания/);
    assert.doesNotMatch(body, /data-state="connected"/);
  });
}

test('result page escapes names and never reflects arbitrary return destinations', () => {
  const body = connectedPage({ provider: 'gitlab', account: '<script>bad</script>', state: 'connected', checkedAt: '2026-10-02T20:00:00Z', items: [{ name: '<img onerror=bad>', id: 7, url: 'https://gitlab.com/a/b', state: 'connected', code: 'verified' }] });
  assert.doesNotMatch(body, /<script>bad|<img onerror/);
  assert.match(body, /&lt;img onerror/);
});

test('language negotiation honors q values and explicit safe language preference', () => {
  assert.equal(uiLanguage({ headers: { 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8' } }), 'ru');
  assert.equal(uiLanguage({ headers: { 'accept-language': 'ru;q=0,en;q=1' } }), 'en');
  assert.equal(uiLanguage({ headers: { cookie: 'peerivo_ui_lang=ru', 'accept-language': 'en' } }), 'ru');
});

test('direct installation page needs no README, and script is safely served same-origin', async t => {
  const f = await setup(t, 'gitlab');
  const response = await fetch(f.base + '/install?lang=ru');
  const body = await response.text();
  assert.match(body, /Подключить GitHub/);
  assert.match(body, /Подключить GitLab/);
  assert.match(body, /Подключить GitVerse/);
  assert.match(body, /github\.com\/apps\/peerivo-reviewer\/installations\/new/);
  assert.match(body, /Reviewer работает с пополняемого баланса/);
  assert.match(body, /href="\/connect\/gitlab"/);
  assert.match(body, /href="\/connect\/gitverse"/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(response.headers.get('set-cookie'), /peerivo_ui_lang=ru;.*HttpOnly; Secure; SameSite=Lax/);
  const logo = await fetch(f.base + '/assets/reviewer-logo.jpg');
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get('content-type'), /image\/jpeg/);
  assert.equal(logo.headers.get('x-content-type-options'), 'nosniff');
  const script = await fetch(f.base + '/assets/installation-ui.js');
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal(script.headers.get('x-content-type-options'), 'nosniff');
});

for (const provider of ['gitlab', 'gitverse']) {
  test(`${provider}: every installer view explains Reviewer and keeps the Reviewer logo`, async t => {
    const f = await setup(t, provider);
    for (const path of ['/install', f.manage, `/${provider}/connected`]) {
      const body = await (await fetch(f.base + path, { headers: { cookie: f.cookie, 'accept-language': 'ru' } })).text();
      assert.match(body, /data-testid="product-description"/);
      assert.match(body, /Peerivo Reviewer проверяет изменения в коде на риски безопасности/);
      assert.match(body, /Код проекта не запускается/);
      assert.match(body, /class="brand-logo" src="\/assets\/reviewer-logo\.jpg"/);
      assert.match(body, /data-testid="license-rule"/);
    }
  });
}

