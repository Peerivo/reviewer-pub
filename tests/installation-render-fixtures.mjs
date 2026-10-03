// Offline browser snapshots: synthetic local installations only, no production account/session access.
import fs from 'node:fs';
import path from 'node:path';
import { installationFixture } from './installation-fixtures.mjs';
import { verifyConnection } from '../src/installation-status.mjs';
import { connectedPage, selectionPage, landingPage } from '../src/installation-ui.mjs';
const output = process.argv[2] || '/tmp/reviewer-installation-html';
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'install.html'), landingPage('ru'));
for (const provider of ['gitlab', 'gitverse']) {
  for (const state of ['connected', 'attention', 'empty']) {
    const f = installationFixture(provider, { installed: state !== 'empty' });
    if (state === 'attention') f.hooks.clear();
    const selection = provider === 'gitlab' ? await f.service.projectSelection(f.sessionToken) : await f.service.repositorySelection(f.sessionToken);
    const model = await verifyConnection(f);
    fs.writeFileSync(path.join(output, `${provider}-${state}.html`), connectedPage(model, 'ru'));
    fs.writeFileSync(path.join(output, `${provider}-manage-${state}.html`), selectionPage({ provider, selection, model, lang: 'ru' }));
    f.service.close();
  }
}
console.log('Rendered synthetic RU installation states to ' + output);
