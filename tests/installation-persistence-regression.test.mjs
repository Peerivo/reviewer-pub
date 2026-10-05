import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../src/server.mjs';
import { installationFixture } from './installation-fixtures.mjs';

// This test also runs against the pre-fix server with only these synthetic fixtures copied in.
for (const provider of ['gitlab', 'gitverse']) {
  const manage = provider === 'gitlab' ? '/gitlab/projects' : '/gitverse/repositories';
  async function start(t) {
    const f = installationFixture(provider);
    const server = createServer({ [`${provider}OAuthConfig`]: f.config, [`${provider}SelfService`]: f.service });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); f.service.close(); });
    return { ...f, base: `http://127.0.0.1:${server.address().port}` };
  }
  test(`${provider}: an installed project's banner remains on a plain management GET`, async t => {
    const f = await start(t);
    const response = await fetch(f.base + manage, { headers: { cookie: f.cookie } });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes('data-testid="connection-banner"'), 'Persistent connection banner must be present without updated=1');
  });
  test(`${provider}: save lands on the provider's canonical post-save page`, async t => {
    const f = await start(t);
    const response = await fetch(f.base + manage, { method: 'POST', redirect: 'manual', headers: { cookie: f.cookie }, body: new URLSearchParams({ csrf: f.csrf, [provider === 'gitlab' ? 'project' : 'repository']: '7' }) });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), provider === 'gitlab' ? manage : `/${provider}/connected`);
  });
}
