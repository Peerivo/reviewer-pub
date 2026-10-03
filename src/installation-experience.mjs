import { providerPaths, verifyConnection } from './installation-status.mjs';
import { connectedPage, errorPage, installationScript, landingPage, selectionPage, uiLanguage } from './installation-ui.mjs';

// Both providers use this handler so save confirmations and persistent status banners cannot drift apart.
export function createInstallationExperience({ runtimeFor, html, redirect, readBody, parseCookie }) {
  return async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/assets/installation-ui.js') {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': Buffer.byteLength(installationScript),
        'cache-control': 'public, max-age=300',
        'x-content-type-options': 'nosniff'
      });
      res.end(installationScript);
      return true;
    }
    const lang = ['ru', 'en'].includes(url.searchParams.get('lang')) ? url.searchParams.get('lang') : uiLanguage(req);
    const options = { privateResponse: true, headers: { vary: 'Accept-Language, Cookie' } };
    if (url.searchParams.has('lang')) {
      options.headers['set-cookie'] = `peerivo_ui_lang=${lang}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/install')) {
      html(res, 200, landingPage(lang), options);
      return true;
    }
    const match = url.pathname.match(/^\/(gitlab|gitverse)\/(projects|repositories|connected)$/);
    if (!match || !['GET', 'POST'].includes(req.method)) return false;
    const provider = match[1];
    const paths = providerPaths(provider);
    if (![paths.manage, paths.connected].includes(url.pathname)) return false;
    if (req.method === 'POST' && url.pathname !== paths.manage) return false;
    try {
      const { service, config } = runtimeFor(provider);
      const sessionToken = parseCookie(req, `peerivo_${provider}_install`);
      if (req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req, 256 * 1024)).toString('utf8'));
        try {
          if (provider === 'gitlab') {
            await service.applyProjects({ sessionToken, csrf: form.get('csrf') || '', projectIds: form.getAll('project') });
          } else {
            await service.applyRepositories({
              sessionToken, csrf: form.get('csrf') || '', repositoryIds: form.getAll('repository'),
              hardGateRepositoryIds: form.has('hard_gate_all') ? form.getAll('repository') : [],
              promoCode: form.get('promo_code') || ''
            });
          }
        } catch (error) {
          // Fixed codes only; never echo provider error text, OAuth credentials, or promo input.
          let code = '';
          if (provider === 'gitverse') {
            if (error?.code === 'checkout_required') code = 'checkout_required';
            else if (error?.code === 'promo_invalid' || (form.get('promo_code') && [404, 409, 410].includes(error?.status))) code = 'promo_invalid';
            else if (error?.status === 402) code = 'license_required';
          }
          if (!code) throw error;
          redirect(res, `${paths.manage}?error=${code}`, { status: 303 });
          return true;
        }
        // POST/Redirect/GET: verification is performed on the destination, not faked from a query flag.
        redirect(res, paths.connected, { status: 303 });
        return true;
      }
      // Perform sequentially so a rotated refresh token is never used concurrently by selection and verification.
      const selection = url.pathname === paths.manage
        ? await (provider === 'gitlab' ? service.projectSelection(sessionToken) : service.repositorySelection(sessionToken))
        : null;
      const model = await verifyConnection({ provider, service, config, sessionToken });
      const body = selection ? selectionPage({ provider, selection, model, lang, error: url.searchParams.get('error') || '', saved: url.searchParams.get('updated') === '1' }) : connectedPage(model, lang);
      html(res, 200, body, options);
    } catch (error) {
      const status = [400, 401, 403, 409, 413, 422].includes(error?.status) ? error.status : 503;
      html(res, status, errorPage(provider, { lang, status }), options);
    }
    return true;
  };
}
