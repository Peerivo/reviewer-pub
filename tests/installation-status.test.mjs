import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyConnection, projectUrl } from '../src/installation-status.mjs';
import { installationFixture } from './installation-fixtures.mjs';

for (const provider of ['gitlab', 'gitverse']) {
  test(`${provider}: read-back verifies access and exact persisted webhook, without exposing credentials`, async t => {
    const f = installationFixture(provider);
    t.after(() => f.service.close());
    const result = await verifyConnection(f);
    assert.equal(result.state, 'connected');
    assert.equal(result.items[0].code, 'verified');
    assert.doesNotMatch(JSON.stringify(result), /NEVER-EXPOSE|csrf|accessToken|refreshToken|webhookSecret/);
    assert.ok(f.calls.some(call => call.path.includes('/hooks')));
    assert.ok(f.calls.every(call => call.method === 'GET'));
    assert.ok(f.calls.every(call => call.signal instanceof AbortSignal));
  });
  test(`${provider}: missing webhook never produces a green connection`, async t => {
    const f = installationFixture(provider); t.after(() => f.service.close()); f.hooks.clear();
    const result = await verifyConnection(f);
    assert.equal(result.state, 'attention');
    assert.equal(result.items[0].code, 'webhook_missing');
  });
  test(`${provider}: an incorrect webhook URL is rejected`, async t => {
    const f = installationFixture(provider); t.after(() => f.service.close());
    const hook = f.hooks.get(7);
    if (provider === 'gitlab') hook.url = 'https://attacker.example/collect'; else hook.config.url = 'https://attacker.example/collect';
    assert.equal((await verifyConnection(f)).items[0].code, 'webhook_invalid');
    assert.ok(f.calls.every(call => !call.path.includes('collect')));
  });
  test(`${provider}: disabled webhook is shown explicitly`, async t => {
    const f = installationFixture(provider); t.after(() => f.service.close());
    if (provider === 'gitlab') f.hooks.get(7).alert_status = 'disabled'; else f.hooks.get(7).active = false;
    assert.equal((await verifyConnection(f)).items[0].code, 'webhook_disabled');
  });
  test(`${provider}: permission loss is reported, with no raw provider error`, async t => {
    const f = installationFixture(provider); t.after(() => f.service.close()); f.mode.httpStatus = 403;
    const result = await verifyConnection(f);
    assert.equal(result.state, 'attention');
    assert.equal(result.items[0].code, 'access_denied');
    assert.doesNotMatch(JSON.stringify(result), /NEVER-EXPOSE/);
  });
  test(`${provider}: a partial installation is not overall success`, async t => {
    const f = installationFixture(provider, { count: 2 }); t.after(() => f.service.close()); f.hooks.delete(8);
    const result = await verifyConnection(f);
    assert.equal(result.state, 'attention');
    assert.deepEqual(result.items.map(item => item.state), ['connected', 'attention']);
  });
  test(`${provider}: selected repository identity cannot change silently`, async t => {
    const f = installationFixture(provider); t.after(() => f.service.close());
    f.mode.wrongIdentity = true;
    assert.equal((await verifyConnection(f)).items[0].code, 'identity_changed');
  });
  test(`${provider}: network timeouts are bounded, keep saved records and never turn green`, async t => {
    const f = installationFixture(provider); t.after(() => f.service.close()); f.mode.neverRespond = true;
    const start = Date.now();
    const result = await verifyConnection({ ...f, timeoutMs: 30 });
    assert.ok(Date.now() - start < 1000);
    assert.equal(result.state, 'pending');
    assert.equal(result.items.length, 1);
    assert.ok(f.service.store.getSessionInstallation(f.sessionToken));
  });
  test(`${provider}: no selected project is neutral, not connected`, async t => {
    const f = installationFixture(provider, { installed: false }); t.after(() => f.service.close());
    const result = await verifyConnection(f);
    assert.equal(result.state, 'empty'); assert.equal(f.calls.length, 0);
  });
  test(`${provider}: invalid session cannot inspect another installation`, async t => {
    const f = installationFixture(provider); t.after(() => f.service.close());
    await assert.rejects(verifyConnection({ ...f, sessionToken: 'wrong-session' }), { status: 401 });
    assert.equal(f.calls.length, 0);
  });
}

test('Self-Managed project links retain configured HTTPS origin and path prefix', () => {
  assert.equal(projectUrl('https://gitlab.example.com/gitlab', 'team/subgroup/app'), 'https://gitlab.example.com/gitlab/team/subgroup/app');
  for (const path of ['a/../b', '//evil.example/a', 'a/./b', 'a/\\evil', 'a/hello world']) assert.throws(() => projectUrl('https://gitlab.com', path));
  for (const base of ['javascript:alert(1)', 'http://gitlab.com', 'https://user:secret@gitlab.com', 'https://gitlab.com?next=evil']) assert.throws(() => projectUrl(base, 'a/b'));
});
