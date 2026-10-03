import assert from 'node:assert/strict';
const base = 'https://pub.reviewer.peerivo.net';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let lastError;
for (let attempt = 0; attempt < 18; attempt++) {
  try {
    const get = path => fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'accept-language': 'ru' } });
    const page = await get('/install');
    assert.equal(page.status, 200);
    const body = await page.text();
    for (const provider of ['gitlab', 'gitverse']) assert.ok(body.includes(`href="/connect/${provider}"`));
    assert.ok(body.includes('Подключить GitHub') && body.includes('Подключить GitLab') && body.includes('Подключить GitVerse'));
    assert.ok(body.includes('https://github.com/apps/peerivo-reviewer/installations/new'));
    assert.ok(body.includes('Одна лицензия активирует один репозиторий'));
    assert.ok(body.includes('Peerivo Reviewer проверяет изменения в коде на риски безопасности'));
    assert.ok(body.includes('data-testid="product-description"'));
    assert.ok(body.includes('class="brand-logo" src="/assets/reviewer-logo.jpg"'));
    const logo = await get('/assets/reviewer-logo.jpg');
    assert.equal(logo.status, 200);
    assert.ok(logo.headers.get('content-type').includes('image/jpeg'));
    const script = await get('/assets/installation-ui.js');
    assert.equal(script.status, 200);
    assert.ok(script.headers.get('content-type').includes('javascript'));
    for (const path of ['/gitlab/connected', '/gitverse/connected', '/gitlab/projects', '/gitverse/repositories']) {
      const response = await get(path);
      assert.equal(response.status, 401, path + ': protected by installation session');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok((await response.text()).includes('Подключить заново'), path + ': useful reconnect action');
    }
    console.log('PASS: GitHub/GitLab/GitVerse cards, Reviewer logo, one-repository license copy, same-origin progressive UI, and protected HTML connection/settings pages. No user authorization or live project verification performed.');
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 17) await pause(10000);
  }
}
console.error('Public installation UI did not become ready within the deploy window:', lastError?.message);
process.exitCode = 1;
