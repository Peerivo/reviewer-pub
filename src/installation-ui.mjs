import { providerPaths } from './installation-status.mjs';

export function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function uiLanguage(req) {
  const explicit = String(req.headers.cookie || '').match(/(?:^|;\s*)peerivo_ui_lang=(ru|en)(?:;|$)/)?.[1];
  if (explicit) return explicit;
  const choices = String(req.headers['accept-language'] || '').split(',').map((item, index) => {
    const [tag, ...parameters] = item.trim().toLowerCase().split(';');
    const q = parameters.find(part => part.trim().startsWith('q='));
    return { lang: tag.split('-')[0], q: q ? Number(q.trim().slice(2)) : 1, index };
  }).filter(item => ['ru', 'en'].includes(item.lang) && item.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
  return choices[0]?.lang || 'en';
}

const copy = {
  en: {
    product: 'Security review for code changes', productDescription: 'Peerivo Reviewer checks pull and merge requests for security risks and reports findings directly in your repository. It does not execute project code.', licenseRule: 'Reviewer uses a prepaid balance. Connected repositories consume that balance; the account shows current spend and an estimate of how many days remain.', githubHint: 'Install the GitHub App and select the repositories you want Reviewer to protect.',
    home: 'Connect your repositories', intro: 'Choose a platform. Authorize Reviewer, select projects, then see a verified connection result. No README hunting or personal tokens.',
    direct: 'Direct connection', connect: 'Connect', manage: 'Manage projects', recheck: 'Check connection again', open: 'Open project', requests: 'Open merge requests', pulls: 'Open pull requests',
    connected: 'Peerivo Reviewer connected', attention: 'Connection needs attention', pending: 'Connection not confirmed', empty: 'Choose projects to connect',
    connectedBody: 'Project access and webhook settings were checked through the platform API.', attentionBody: 'At least one project needs a fix. See the reason below; the connection is not marked as successful.', pendingBody: 'The platform did not confirm the connection. Your saved selection has not been removed. Retry the check.', emptyBody: 'Your account is authorized, but no projects are connected yet.',
    scope: 'This checks the connection, not the code or the overall CI result. Open or update a pull / merge request to get a Reviewer report.',
    next: 'What happens next?', nextText: 'Open a connected project and create or update a pull / merge request. Reviewer will publish its result there. You can return here to check the connection or change projects.',
    account: 'Account', checked: 'Last checked', selected: 'Configured projects', settings: 'Connection settings',
    choose: 'Select projects for Reviewer', chooseText: 'Only projects you can administer are offered. Saving takes you to a separate connection check and confirmation page.',
    save: 'Save and verify connection', saving: 'Saving connection…', progress: 'Saving settings, then checking the connection. Please keep this tab open.', disconnect: 'Disconnect',
    noProjects: 'No eligible projects are available. Check your Maintainer / Owner access or authorize another account.',
    signedIn: 'Authorized account', back: 'Connection overview', reauthorize: 'Authorize again', errorTitle: 'Connection could not be completed',
    session: 'Your installation session has expired. Authorize again to manage your projects. This does not disconnect already installed repositories.',
    denied: 'The operation was not authorized. Refresh the page and check your account permissions before saving again.',
    conflict: 'Some settings could not be saved. A project may belong to another installation. No complete success is being reported; check the saved connection and retry.',
    failed: 'Settings could not be fully saved or verified. Some changes may already have been applied. Check the current connection before trying again.',
    saved: 'Settings saved. The current connection state is shown below.',
    promo: 'Promo code', optional: 'optional', promoHelp: 'Leave blank to activate the free trial automatically. No license key needs to be copied into GitVerse.',
    gate: 'Block merge on HIGH/CRITICAL', gateHelp: 'Installs the Peerivo Reviewer Hard Merge Gate in selected repositories. Its CI result is separate from this connection check.',
    gateConfigured: 'Hard Merge Gate configured; CI execution not checked here.',
    promo_invalid: 'Promo code not accepted. Check the code and try again.', license_required: 'Reviewer access is required. Activate a license or enter a valid promo code.', checkout_required: 'This discount requires a paid checkout before activation.',
    verified: 'Access and webhook verified', access_denied: 'Access is missing, insufficient, or the project is archived. Check permissions and authorize again.', identity_changed: 'Project identity has changed. Re-select the project and save its connection again.', webhook_missing: 'Reviewer webhook is missing. Save this project again to restore it.', webhook_invalid: 'Webhook URL or subscribed events do not match Reviewer. Save this project again to repair its settings.', webhook_disabled: 'The webhook is disabled. Check its delivery errors in the platform before retrying.', unavailable: 'The platform could not be reached or returned incomplete data. Retry the connection check.',
    platform: 'Platform', privacy: 'Tokens remain on the server. Reviewer does not execute your project code.', installed: 'Selected', notSelected: 'Not selected', footer: 'Connection verification is read-only: no test commits, pipelines or reviews are started.'
  },
  ru: {
    product: 'Проверка безопасности изменений в коде', productDescription: 'Peerivo Reviewer проверяет изменения в коде на риски безопасности и показывает найденные проблемы прямо в pull/merge request. Код проекта не запускается.', licenseRule: 'Reviewer работает с пополняемого баланса. Подключённые репозитории расходуют баланс; в кабинете будет виден текущий расход и примерно на сколько дней хватит денег.', githubHint: 'Установите GitHub App и выберите репозитории, которые должен защищать Reviewer.',
    home: 'Подключите свои репозитории', intro: 'Выберите платформу, разрешите доступ и отметьте проекты. После сохранения — проверка подключения и понятный результат. Без поиска кнопки в README и передачи токенов.',
    direct: 'Прямое подключение', connect: 'Подключить', manage: 'Управлять проектами', recheck: 'Проверить подключение ещё раз', open: 'Открыть проект', requests: 'Перейти к merge request', pulls: 'Перейти к pull request',
    connected: 'Peerivo Reviewer подключён', attention: 'Подключение требует внимания', pending: 'Подключение не подтверждено', empty: 'Выберите проекты для подключения',
    connectedBody: 'Доступ к проектам и настройки вебхуков проверены через API платформы.', attentionBody: 'В одном или нескольких проектах есть проблема. Причина указана ниже — успешное подключение не подменяет ошибку.', pendingBody: 'Платформа не подтвердила подключение. Сохранённые проекты не удалены. Повторите проверку.', emptyBody: 'Вход выполнен, но ни один проект пока не подключён.',
    scope: 'Это проверка подключения, а не проверка кода или всего CI. Отчёт Reviewer появится в новом или обновлённом pull / merge request.',
    next: 'Что дальше?', nextText: 'Откройте подключённый проект и создайте или обновите pull / merge request. Reviewer опубликует результат там. Сюда можно вернуться, чтобы проверить подключение или изменить список проектов.',
    account: 'Аккаунт', checked: 'Последняя проверка', selected: 'Настроенные проекты', settings: 'Настройки подключения',
    choose: 'Выберите проекты для Reviewer', chooseText: 'В списке — проекты, которыми вы можете управлять. После сохранения откроется отдельная страница проверки и подтверждения подключения.',
    save: 'Сохранить и проверить подключение', saving: 'Сохраняем подключение…', progress: 'Сохраняем настройки, затем проверим подключение. Не закрывайте вкладку.', disconnect: 'Отключить',
    noProjects: 'Подходящих проектов нет. Проверьте права Maintainer / Owner или войдите под другим аккаунтом.',
    signedIn: 'Вход выполнен', back: 'Состояние подключения', reauthorize: 'Подключить заново', errorTitle: 'Не удалось завершить подключение',
    session: 'Сессия управления истекла. Войдите повторно, чтобы управлять проектами. Уже подключённые репозитории при этом не отключаются.',
    denied: 'Операция не разрешена. Обновите страницу и проверьте права аккаунта перед повторным сохранением.',
    conflict: 'Не все настройки удалось сохранить. Возможно, проект связан с другой установкой. Полный успех не подтверждён — проверьте текущее состояние и повторите попытку.',
    failed: 'Не удалось полностью сохранить или проверить настройки. Часть изменений могла примениться. Сначала проверьте текущее состояние подключения.',
    saved: 'Настройки сохранены. Текущее состояние подключения показано ниже.',
    promo: 'Промокод', optional: 'необязательно', promoHelp: 'Оставьте поле пустым для автоматической активации пробного периода. Копировать ключ лицензии в GitVerse не нужно.',
    gate: 'Блокировать слияние при HIGH/CRITICAL', gateHelp: 'Устанавливает Peerivo Reviewer Hard Merge Gate в выбранные репозитории. Результат CI проверяется отдельно от подключения.',
    gateConfigured: 'Hard Merge Gate настроен; выполнение CI здесь не проверяется.',
    promo_invalid: 'Промокод не принят. Проверьте его и повторите попытку.', license_required: 'Нужен доступ к Reviewer. Активируйте лицензию или введите действующий промокод.', checkout_required: 'Для активации скидочного промокода сначала требуется оплата.',
    verified: 'Доступ и вебхук проверены', access_denied: 'Недостаточно прав, проект недоступен или архивирован. Проверьте доступ и подключите аккаунт заново.', identity_changed: 'Идентификатор или путь проекта изменился. Выберите проект и сохраните подключение заново.', webhook_missing: 'Вебхук Reviewer не найден. Повторно сохраните этот проект, чтобы восстановить его.', webhook_invalid: 'Адрес или события вебхука не соответствуют Reviewer. Повторно сохраните проект для исправления настроек.', webhook_disabled: 'Вебхук отключён. Проверьте ошибки доставки на платформе и повторите проверку.', unavailable: 'Платформа недоступна или вернула неполные данные. Повторите проверку подключения.',
    platform: 'Платформа', privacy: 'Токены остаются на сервере. Reviewer не запускает код вашего проекта.', installed: 'Выбран', notSelected: 'Не выбран', footer: 'Проверка подключения не создаёт коммитов, не запускает pipeline и не выполняет ревью.'
  }
};

export const installationCss = `
:root{color-scheme:light;--ink:#20212a;--muted:#5d6274;--line:#e3e6ed;--green:#147747;--red:#ac2035;--amber:#81580c;--brand:#5b45c5}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(150deg,#f4f5fb 0%,#f8fafb 65%,#eff8f2 100%);color:var(--ink);font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}a{color:var(--brand);text-underline-offset:3px}main{max-width:1000px;margin:0 auto;padding:28px 24px 64px}.product-intro{border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:28px}.product-intro p{font-size:14px;margin:6px 0 0;max-width:760px}.product-intro strong{font-size:15px}.license-note{display:flex;align-items:flex-start;gap:9px;margin:16px 0 0;padding:12px 14px;border:1px solid #cfd8ff;background:#f5f7ff;border-radius:11px;color:#39436b;font-size:14px}.license-note b{color:var(--brand)}header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:32px}.brand{font-weight:780;letter-spacing:-.02em;font-size:20px;color:var(--ink);text-decoration:none;display:inline-flex;align-items:center}.brand-logo{width:40px;height:40px;border-radius:12px;object-fit:cover;margin-right:10px;box-shadow:0 4px 14px #0d6eff33}.provider{font-size:13px;font-weight:650;background:white;border:1px solid var(--line);padding:5px 12px;border-radius:999px}h1{font-size:clamp(26px,4vw,38px);line-height:1.2;letter-spacing:-.035em;margin:8px 0 14px}h2{font-size:22px;line-height:1.3;margin:0 0 10px;letter-spacing:-.02em}p{margin:8px 0 16px;color:var(--muted)}.eyebrow{text-transform:uppercase;font-size:12px;font-weight:750;letter-spacing:.13em;color:var(--brand)}.steps{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:13px;color:var(--muted);margin:22px 0}.steps span{display:flex;gap:6px;align-items:center}.steps b{background:#e9e5fb;border-radius:99px;width:23px;height:23px;text-align:center;color:var(--brand)}.panel{background:white;border:1px solid var(--line);border-radius:18px;padding:26px;margin:22px 0;box-shadow:0 6px 24px #20212a05}.connection-banner{display:grid;grid-template-columns:44px minmax(0,1fr);gap:17px;padding:26px;border:1px solid var(--line);border-radius:18px;background:white;margin:24px 0}.connection-banner.connected{background:#f0fbf4;border-color:#a9ddbd}.connection-banner.attention{background:#fff2f3;border-color:#efb3bc}.connection-banner.pending{background:#fff9e9;border-color:#e6d29d}.connection-icon{display:grid;place-items:center;align-self:start;width:42px;height:42px;border-radius:14px;color:white;background:var(--muted);font-weight:800;font-size:23px}.connected .connection-icon{background:var(--green)}.attention .connection-icon{background:var(--red)}.pending .connection-icon{background:var(--amber)}.connection-banner p{margin:8px 0}.connection-meta{font-size:13px}.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:18px}.button,button{font:inherit;font-size:14px;font-weight:650;line-height:1.35;display:inline-flex;justify-content:center;align-items:center;min-height:44px;padding:11px 17px;gap:8px;border:1px solid #cbcbd8;background:white;border-radius:10px;color:var(--ink);text-decoration:none;cursor:pointer;text-align:center}.button.primary,button.primary{background:var(--ink);color:white;border-color:var(--ink)}.connected .button.primary{background:var(--green);border-color:var(--green)}a:hover,button:hover{filter:brightness(.94)}:focus-visible{outline:3px solid #7564d9;outline-offset:3px}button:disabled{opacity:.65;cursor:wait}.scope{font-size:14px;border-left:3px solid #b4bdd0;padding-left:13px;margin-top:22px}.projects{display:grid;gap:12px}.project-row{padding:17px;border:1px solid var(--line);border-radius:12px;display:grid;gap:8px;min-width:0}.project-name{font-weight:750;overflow-wrap:anywhere}.project-row .actions{margin-top:3px}.project-row p{margin:0;font-size:14px}.tag{display:inline-flex;gap:6px;align-items:center;width:fit-content;font-weight:650;font-size:13px;color:var(--muted)}.tag.connected{color:var(--green)}.tag.attention{color:var(--red)}.tag.pending{color:var(--amber)}.project-choice{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line);border-radius:11px;padding:14px;cursor:pointer}.project-choice input{width:19px;height:19px;margin-top:4px;flex-shrink:0;accent-color:var(--brand)}.project-choice span{min-width:0;display:grid;overflow-wrap:anywhere}.project-choice small,.hint{color:var(--muted);font-size:13px}.field{display:grid;gap:7px;margin:22px 0}.field input[type=text]{width:100%;max-width:420px;padding:11px 13px;border:1px solid #c7ccda;border-radius:9px;font:inherit}.gate{background:#f7f8fb;margin:18px 0}.saved{font-size:14px;color:var(--green)}.error-notice{border:1px solid #efb3bc;background:#fff2f3;color:var(--red);padding:14px;border-radius:10px;margin:16px 0}.busy{color:var(--brand);margin:14px 0 0}.muted-section{padding-top:22px;border-top:1px solid var(--line);margin-top:32px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin-top:26px}.cards .panel{margin:0}.platform-letter{display:grid;place-items:center;width:48px;height:48px;border-radius:13px;background:#eeeafa;color:var(--brand);font-size:23px;font-weight:750;margin-bottom:15px}small,code,footer{overflow-wrap:anywhere}footer{font-size:12px;color:var(--muted);margin-top:30px}time{white-space:normal}.panel,.connection-banner,.actions{min-width:0}.actions>a,.actions>button{max-width:100%;overflow-wrap:anywhere}
@media(max-width:580px){main{padding:18px 16px 40px}header{margin-bottom:23px}.panel,.connection-banner{padding:20px 16px}.connection-banner{grid-template-columns:1fr;gap:12px}.cards{grid-template-columns:1fr}.actions{align-items:stretch}.actions .button,.actions button{flex:1 1 100%}.brand{font-size:17px}.steps{font-size:12px;gap:8px}.project-row{padding:14px}}
`;

function page(body, { lang = 'en', title = 'Peerivo Reviewer', provider = '' } = {}) {
  const c = copy[lang];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${escapeHtml(c.productDescription)}"><link rel="icon" type="image/jpeg" href="/assets/reviewer-logo.jpg"><title>${escapeHtml(title)} · Peerivo Reviewer</title><style>${installationCss}</style><script defer src="/assets/installation-ui.js"></script></head><body><main><header><a class="brand" href="/"><img class="brand-logo" src="/assets/reviewer-logo.jpg" alt="" width="40" height="40">Peerivo Reviewer</a><span class="provider">${provider ? providerPaths(provider).name : c.direct}</span></header><section class="product-intro" aria-label="${escapeHtml(c.product)}" data-testid="product-description"><strong>${c.product}</strong><p>${c.productDescription}</p><div class="license-note" data-testid="license-rule"><b>₽/$</b><span>${c.licenseRule}</span></div></section>${body}<footer>${c.privacy}</footer></main></body></html>`;
}

function steps(lang) {
  const items = lang === 'ru' ? ['Разрешить доступ', 'Выбрать проекты', 'Проверить подключение'] : ['Authorize', 'Select projects', 'Verify connection'];
  return `<nav class="steps" aria-label="${lang === 'ru' ? 'Шаги подключения' : 'Connection steps'}">${items.map((text, index) => `<span><b>${index + 1}</b>${text}</span>`).join('')}</nav>`;
}

function button(href, text, primary = false) {
  return `<a class="button${primary ? ' primary' : ''}" href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

export function connectionBanner(model, lang = 'en') {
  const c = copy[lang];
  const paths = providerPaths(model.provider);
  const state = ['connected', 'attention', 'pending', 'empty'].includes(model.state) ? model.state : 'pending';
  const first = model.items[0];
  const issues = model.items.filter(item => item.state !== 'connected').map(item => `<p class="connection-meta"><strong>${escapeHtml(item.name)}</strong>: ${c[item.code] || c.unavailable}</p>`).join('');
  const icon = state === 'connected' ? '✓' : state === 'empty' ? '+' : '!';
  const when = model.checkedAt ? new Date(model.checkedAt).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-GB', { timeZone: 'UTC' }) + ' UTC' : '';
  return `<section class="connection-banner ${state}" data-testid="connection-banner" data-state="${state}" role="${state === 'attention' ? 'alert' : 'status'}"><div class="connection-icon" aria-hidden="true">${icon}</div><div><h2>${c[state]}</h2><p>${c[state + 'Body']}</p>${issues}<p class="connection-meta">${c.account}: <strong>${escapeHtml(model.account)}</strong>${when ? ` · ${c.checked}: <time datetime="${escapeHtml(model.checkedAt)}">${escapeHtml(when)}</time>` : ''}</p><div class="actions">${first ? button(first.url, c.open + ' ↗', state === 'connected') : button(paths.manage, c.manage, true)}${first ? button(first.url + (model.provider === 'gitlab' ? '/-/merge_requests' : '/pulls'), model.provider === 'gitlab' ? c.requests : c.pulls) : ''}${button(paths.connected, c.recheck)}${first ? button(paths.manage, c.manage) : ''}</div></div></section>`;
}

function projectRows(model, lang) {
  const c = copy[lang];
  return model.items.map(item => `<article class="project-row"><div class="project-name">${escapeHtml(item.name)}</div><span class="tag ${item.state}">${item.state === 'connected' ? '✓' : '!'} ${c[item.code] || c.unavailable}</span>${item.hardGateConfigured ? `<p class="hint">${c.gateConfigured}</p>` : ''}<div class="actions">${button(item.url, c.open + ' ↗')}</div></article>`).join('');
}

export function connectedPage(model, lang = 'en') {
  const c = copy[lang];
  const paths = providerPaths(model.provider);
  return page(`<div class="eyebrow">${paths.name} · ${c.settings}</div><h1>${c.back}</h1>${steps(lang)}${connectionBanner(model, lang)}${model.items.length ? `<section class="panel"><h2>${c.selected} · ${model.items.length}</h2><div class="projects">${projectRows(model, lang)}</div><p class="scope">${c.scope}</p></section>` : ''}<section class="panel"><h2>${c.next}</h2><p>${c.nextText}</p><div class="actions">${button(paths.manage, c.manage)}${button(paths.connect + '?reauthorize=1', c.reauthorize)}</div></section><footer>${c.footer}</footer>`, { lang, provider: model.provider, title: c.back });
}

export function selectionPage({ provider, selection, model, lang = 'en', error = '', saved = false }) {
  const c = copy[lang];
  const paths = providerPaths(provider);
  const isGitLab = provider === 'gitlab';
  const projects = isGitLab ? selection.projects : selection.repositories;
  const selected = projects.filter(item => item.selected);
  const rows = projects.map(item => `<label class="project-choice"><input type="checkbox" name="${isGitLab ? 'project' : 'repository'}" value="${item.id}"${item.selected ? ' checked' : ''}><span><strong>${escapeHtml(isGitLab ? item.pathWithNamespace : item.fullName)}</strong><small>${escapeHtml(item.visibility)} · ${item.selected ? c.installed : c.notSelected}</small></span></label>`).join('');
  const allGate = selected.length > 0 && selected.every(item => item.hardGateEnabled);
  const code = ['promo_invalid', 'license_required', 'checkout_required'].includes(error) ? error : '';
  return page(`<div class="eyebrow">${paths.name} · ${c.settings}</div><h1>${c.choose}</h1><p>${c.signedIn}: <strong>${escapeHtml(selection.username || selection.login)}</strong>. ${c.chooseText}</p>${steps(lang)}${connectionBanner(model, lang)}${saved ? `<p class="saved">${c.saved}</p>` : ''}${code ? `<div class="error-notice" role="alert">${c[code]}</div>` : ''}<section class="panel"><form method="post" action="${paths.manage}" data-busy="${c.saving}"><input type="hidden" name="csrf" value="${escapeHtml(selection.csrf)}"><div class="projects">${rows || `<p>${c.noProjects}</p>`}</div>${isGitLab ? '' : `<label class="field"><strong>${c.promo} <small>(${c.optional})</small></strong><input type="text" name="promo_code" maxlength="96" autocomplete="off" placeholder="PVR-XXXX-XXXX-XXXX"><small>${c.promoHelp}</small></label><label class="project-choice gate"><input type="checkbox" name="hard_gate_all" value="1"${allGate ? ' checked' : ''}><span><strong>${c.gate}</strong><small>${c.gateHelp}</small></span></label>`}<div class="actions"><button class="primary" type="submit">${c.save}</button>${button(paths.connected, c.back)}</div><p class="busy" role="status" hidden>${c.progress}</p></form><p class="scope">${c.scope}</p><form class="muted-section" method="post" action="/${provider}/disconnect"><input type="hidden" name="csrf" value="${escapeHtml(selection.csrf)}"><button type="submit">${c.disconnect} ${paths.name}</button></form></section>`, { lang, provider, title: c.choose });
}

export function errorPage(provider, { lang = 'en', status = 503, cancelled = false } = {}) {
  const c = copy[lang];
  const paths = providerPaths(provider);
  const message = cancelled ? (lang === 'ru' ? 'Вы отменили разрешение доступа. Подключение не завершено.' : 'Authorization was cancelled. Connection was not completed.') : status === 401 ? c.session : [400, 403].includes(status) ? c.denied : status === 409 ? c.conflict : c.failed;
  return page(`<section class="connection-banner attention" role="alert"><div class="connection-icon" aria-hidden="true">!</div><div><h1>${c.errorTitle}</h1><p>${message}</p><div class="actions">${button(paths.connect + '?reauthorize=1', c.reauthorize, true)}${button(paths.connected, c.back)}${button(paths.manage, c.manage)}</div></div></section>`, { lang, provider, title: c.errorTitle });
}

export function landingPage(lang = 'en') {
  const c = copy[lang];
  const githubInstall = 'https://github.com/apps/peerivo-reviewer/installations/new';
  const githubCard = `<section class="panel"><div class="platform-letter" aria-hidden="true">GH</div><h2>GitHub</h2><p>${c.githubHint}</p><div class="actions">${button(githubInstall, `${c.connect} GitHub`, true)}</div></section>`;
  const providerCards = ['gitlab', 'gitverse'].map(provider => { const paths = providerPaths(provider); return `<section class="panel"><div class="platform-letter" aria-hidden="true">${provider === 'gitlab' ? 'GL' : 'GV'}</div><h2>${paths.name}</h2><p>${lang === 'ru' ? 'Вход → выбор репозиториев → проверка → переход в проект.' : 'Authorize → choose repositories → verify → open your project.'}</p><div class="actions">${button(paths.connect, `${c.connect} ${paths.name}`, true)}${button(paths.manage, c.manage)}</div></section>`; }).join('');
  return page(`<div class="eyebrow">${c.direct}</div><h1>${c.home}</h1><p>${c.intro}</p>${steps(lang)}<div class="cards">${githubCard}${providerCards}</div>`, { lang, title: c.home });
}

export const installationScript = `document.querySelectorAll('form[data-busy]').forEach(form => {const button = form.querySelector('button[type="submit"]');const label = button.textContent;form.addEventListener('submit', event => {if (button.disabled) {event.preventDefault();return;}button.disabled = true;button.textContent = form.dataset.busy;form.setAttribute('aria-busy', 'true');form.querySelector('.busy').hidden = false;});window.addEventListener('pageshow', () => {button.disabled = false;button.textContent = label;form.removeAttribute('aria-busy');form.querySelector('.busy').hidden = true;});});`;
