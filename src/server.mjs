import http from "node:http";
import { createApp } from "./app.mjs";
import { createGitLabApp } from "./gitlab-app.mjs";
import { createGitLabCiBridge, formatGitLabCiConsoleResult } from "./gitlab-ci.mjs";
import { bootstrapGitLabCatalog } from "./gitlab-catalog-bootstrap.mjs";
import { createGitLabSelfService } from "./gitlab-self-service.mjs";
import { createGitVerseApp } from "./gitverse-app.mjs";
import { createGitVerseSelfService } from "./gitverse-self-service.mjs";
import { loadConfig, loadGitLabConfig, loadGitLabOAuthConfigOptional, loadGitVerseOAuthConfigOptional, loadServerConfig } from "./config.mjs";
import { GITVERSE_REVIEWER_WORKFLOW, GITVERSE_REVIEWER_WORKFLOW_PATH } from "./gitverse-workflow.mjs";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const MAX_FORM_BYTES = 256 * 1024;
const GITLAB_SESSION_COOKIE = "peerivo_gitlab_install";
const GITVERSE_SESSION_COOKIE = "peerivo_gitverse_install";

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(raw);
}

function plain(res, status, body) {
  const raw = String(body || "");
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(raw);
}

function html(res, status, body, { privateResponse = false, headers = {} } = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": privateResponse ? "no-store" : "public, max-age=300",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...headers
  });
  res.end(body);
}

function redirect(res, location, { headers = {}, status = 302 } = {}) {
  res.writeHead(status, {
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end();
}

async function readBody(req, maxBytes = MAX_WEBHOOK_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseCookie(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const pair of raw.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return "";
}

function sessionCookie(token, maxAgeSeconds) {
  return `${GITLAB_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${GITLAB_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function gitverseSessionCookie(token, maxAgeSeconds) {
  return `${GITVERSE_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

function clearGitVerseSessionCookie() {
  return `${GITVERSE_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function projectsPage(selection, { updated = false } = {}) {
  const rows = selection.projects.map(project => {
    const checked = project.selected ? " checked" : "";
    const detail = project.visibility ? ` · ${escapeHtml(project.visibility)}` : "";
    return `<label class="project"><input type="checkbox" name="project" value="${project.id}"${checked}><span><strong>${escapeHtml(project.pathWithNamespace)}</strong><small>${escapeHtml(project.name)}${detail}</small></span></label>`;
  }).join("");

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect GitLab · Peerivo Reviewer</title>
<style>
body{font-family:system-ui,sans-serif;max-width:860px;margin:7vh auto;padding:0 24px;line-height:1.5;color:#18181b}
h1{font-size:2rem;margin-bottom:.4rem}p{color:#52525b}.notice{padding:12px 14px;background:#f4f4f5;border-radius:10px}
.projects{display:grid;gap:8px;margin:24px 0}.project{display:flex;gap:12px;padding:12px;border:1px solid #e4e4e7;border-radius:10px;align-items:flex-start}
.project input{margin-top:5px}.project span{display:grid}.project small{color:#71717a}
.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}button{font:inherit;padding:10px 16px;border-radius:9px;border:1px solid #18181b;background:#18181b;color:white;cursor:pointer}
.secondary button{background:white;color:#18181b}.secondary{margin-top:28px}
</style>
<h1>Connect GitLab</h1>
<p>Signed in as <strong>${escapeHtml(selection.username)}</strong>. Select projects where Peerivo Reviewer should review merge requests.</p>
${updated ? '<p class="notice">GitLab installation updated.</p>' : ""}
<form method="post" action="/gitlab/projects">
<input type="hidden" name="csrf" value="${escapeHtml(selection.csrf)}">
<div class="projects">${rows || "<p>No Maintainer/Owner projects are available to this account.</p>"}</div>
<div class="actions"><button type="submit">Save GitLab projects</button></div>
</form>
<form class="secondary" method="post" action="/gitlab/disconnect">
<input type="hidden" name="csrf" value="${escapeHtml(selection.csrf)}">
<button type="submit">Disconnect GitLab</button>
</form>`;
}

function repositoriesPage(selection, { updated = false, access = "", error = "" } = {}) {
  const rows = selection.repositories.map(repository => {
    const checked = repository.selected ? " checked" : "";
    const detail = repository.visibility ? ` · ${escapeHtml(repository.visibility)}` : "";
    const gate = repository.hardGateEnabled ? " · Hard gate enabled" : "";
    return `<label class="project"><input type="checkbox" name="repository" value="${repository.id}"${checked}><span><strong>${escapeHtml(repository.fullName)}</strong><small>${escapeHtml(repository.name)}${detail}${gate}</small></span></label>`;
  }).join("");

  const selected = selection.repositories.filter(repository => repository.selected);
  const selectedGateCount = selected.filter(repository => repository.hardGateEnabled).length;
  const hardGateAll = selected.length > 0 && selectedGateCount === selected.length;
  const selectedLinks = selected.map(repository => {
    const href = `https://gitverse.ru/${String(repository.fullName).split("/").map(encodeURIComponent).join("/")}`;
    return `<a class="repo-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(repository.fullName)} ↗</a>`;
  }).join("");

  const accessLine = access === "trial"
    ? " Free trial activated."
    : access === "promo"
      ? " Promo code applied and Reviewer access activated."
      : access === "active"
        ? " Existing Reviewer access remains active."
        : "";
  const errorPanel = error === "license_required"
    ? `<section class="billing-error" role="alert"><strong>Reviewer access required</strong><span>Your trial has ended. Activate a license or enter a promo code to continue.</span></section>`
    : error === "promo_invalid"
      ? `<section class="billing-error" role="alert"><strong>Promo code not accepted</strong><span>The promo code is invalid, expired, or unavailable.</span></section>`
      : error === "checkout_required"
        ? `<section class="billing-error" role="alert"><strong>Checkout required</strong><span>This discount promo requires a paid checkout before Reviewer can be activated.</span></section>`
        : "";

  const success = updated
    ? selected.length > 0
      ? `<section class="success" role="status">
          <div class="success-mark">✓</div>
          <div>
            <h2>Peerivo Reviewer connected</h2>
            <p>Settings saved. Reviewer is enabled for ${selected.length} ${selected.length === 1 ? "repository" : "repositories"} and will run on new or updated pull requests.${selectedGateCount ? ` Hard Merge Gate is active for ${selectedGateCount}.` : ""}${accessLine}</p>
            <div class="connected-repos">${selectedLinks}</div>
            <div class="success-actions">
              <a class="button primary" href="${escapeHtml(`https://gitverse.ru/${String(selected[0].fullName).split("/").map(encodeURIComponent).join("/")}`)}" target="_blank" rel="noopener">Open repository</a>
              <a class="button secondary-link" href="/gitverse/repositories">Manage repositories</a>
            </div>
          </div>
        </section>`
      : `<section class="success neutral" role="status">
          <div class="success-mark">✓</div>
          <div>
            <h2>GitVerse settings saved</h2>
            <p>No repositories are selected. Peerivo Reviewer is not active for any GitVerse repository yet.</p>
          </div>
        </section>`
    : "";

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect GitVerse · Peerivo Reviewer</title>
<style>
body{font-family:system-ui,sans-serif;max-width:860px;margin:7vh auto;padding:0 24px;line-height:1.5;color:#18181b}
h1{font-size:2rem;margin-bottom:.4rem}h2{margin:.1rem 0 .35rem;font-size:1.35rem}p{color:#52525b}
.success{display:grid;grid-template-columns:auto 1fr;gap:14px;padding:18px 20px;margin:20px 0 28px;border:1px solid #86efac;background:#f0fdf4;border-radius:14px}
.success.neutral{border-color:#d4d4d8;background:#fafafa}.success-mark{width:34px;height:34px;border-radius:999px;display:grid;place-items:center;background:#16a34a;color:white;font-weight:800;font-size:1.1rem}
.success p{margin:.2rem 0 .8rem}.connected-repos{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 14px}.repo-link{padding:6px 9px;background:white;border:1px solid #bbf7d0;border-radius:8px;text-decoration:none;color:#166534;font-weight:650}
.success-actions,.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.button,button{font:inherit;padding:10px 16px;border-radius:9px;border:1px solid #18181b;text-decoration:none;cursor:pointer}
.primary,button{background:#18181b;color:white}.secondary-link{background:white;color:#18181b}
.billing-error{display:grid;gap:4px;padding:14px 16px;margin:18px 0;border:1px solid #fca5a5;background:#fef2f2;border-radius:10px}.billing-error span{color:#7f1d1d}.promo{display:grid;gap:6px;margin:0 0 18px}.promo input{font:inherit;padding:10px 12px;border:1px solid #d4d4d8;border-radius:9px;max-width:360px}.promo small{color:#71717a}
.projects{display:grid;gap:8px;margin:24px 0}.project{display:flex;gap:12px;padding:12px;border:1px solid #e4e4e7;border-radius:10px;align-items:flex-start}
.project input{margin-top:5px}.project span{display:grid}.project small{color:#71717a}.gate-option{display:flex;gap:10px;align-items:flex-start;padding:14px;margin:0 0 18px;border:1px solid #d4d4d8;border-radius:10px;background:#fafafa}.gate-option input{margin-top:5px}.gate-option span{display:grid}.gate-option small{color:#71717a}.secondary button{background:white;color:#18181b}.secondary{margin-top:28px}
</style>
<h1>Connect GitVerse</h1>
<p>Signed in as <strong>${escapeHtml(selection.login)}</strong>. Select repositories where Peerivo Reviewer should review pull requests.</p>
${errorPanel}
${success}
<form method="post" action="/gitverse/repositories">
<input type="hidden" name="csrf" value="${escapeHtml(selection.csrf)}">
<div class="projects">${rows || "<p>No Owner/Admin repositories are available to this account.</p>"}</div>
<label class="promo"><strong>Promo code <span style="font-weight:400;color:#71717a">(optional)</span></strong><input type="text" name="promo_code" maxlength="96" autocomplete="off" placeholder="PVR-XXXX-XXXX-XXXX"><small>Leave blank to activate the free trial automatically. No license key needs to be copied into GitVerse.</small></label>
<label class="gate-option"><input type="checkbox" name="hard_gate_all" value="1"${hardGateAll ? " checked" : ""}><span><strong>Block merge on HIGH/CRITICAL</strong><small>Installs the Peerivo Reviewer Hard Merge Gate into every selected repository automatically. No YAML or secrets to copy.</small></span></label>
<div class="actions"><button type="submit">Save GitVerse repositories</button></div>
</form>
<form class="secondary" method="post" action="/gitverse/disconnect">
<input type="hidden" name="csrf" value="${escapeHtml(selection.csrf)}">
<button type="submit">Disconnect GitVerse</button>
</form>`;
}

function backgroundFailure(error, deliveryId) {
  const kind = error?.name || "Error";
  process.stderr.write(`Reviewer delivery ${deliveryId || "unknown"} failed closed (${kind})\n`);
}

export function createServer({
  config,
  gitlabConfig,
  gitlabOAuthConfig,
  gitlabSelfService,
  gitverseOAuthConfig,
  gitverseSelfService,
  fetchImpl = fetch
} = {}) {
  let githubApp;
  let gitlabApp;
  let gitlabCiBridge;
  let selfService = gitlabSelfService || null;
  let oauthConfigResolved = gitlabOAuthConfig !== undefined;
  let resolvedOAuthConfig = gitlabOAuthConfig ?? null;
  let gitverseApp;
  let gitverseService = gitverseSelfService || null;
  let gitverseOAuthConfigResolved = gitverseOAuthConfig !== undefined;
  let resolvedGitVerseOAuthConfig = gitverseOAuthConfig ?? null;

  const getGithubApp = () => {
    if (!githubApp) githubApp = createApp({ config: config || loadConfig(), fetchImpl });
    return githubApp;
  };

  const getGitLabSelfService = ({ required = false } = {}) => {
    if (selfService) return selfService;
    if (!oauthConfigResolved) {
      resolvedOAuthConfig = loadGitLabOAuthConfigOptional();
      oauthConfigResolved = true;
    }
    if (!resolvedOAuthConfig) {
      if (required) throw Object.assign(new Error("GitLab OAuth self-service is not configured"), { status: 503 });
      return null;
    }
    selfService = createGitLabSelfService({ config: resolvedOAuthConfig, fetchImpl });
    return selfService;
  };

  const getGitLabApp = () => {
    if (!gitlabApp) {
      gitlabApp = createGitLabApp({
        config: gitlabConfig || loadGitLabConfig(),
        selfService: getGitLabSelfService(),
        fetchImpl
      });
    }
    return gitlabApp;
  };

  const getGitLabCiBridge = () => {
    if (!gitlabCiBridge) {
      gitlabCiBridge = createGitLabCiBridge({
        config: gitlabConfig || loadGitLabConfig(),
        selfService: getGitLabSelfService({ required: true }),
        fetchImpl
      });
    }
    return gitlabCiBridge;
  };

  const getGitVerseSelfService = ({ required = false } = {}) => {
    if (gitverseService) return gitverseService;
    if (!gitverseOAuthConfigResolved) {
      resolvedGitVerseOAuthConfig = loadGitVerseOAuthConfigOptional();
      gitverseOAuthConfigResolved = true;
    }
    if (!resolvedGitVerseOAuthConfig) {
      if (required) throw Object.assign(new Error("GitVerse OAuth self-service is not configured"), { status: 503 });
      return null;
    }
    gitverseService = createGitVerseSelfService({ config: resolvedGitVerseOAuthConfig, fetchImpl });
    return gitverseService;
  };

  const getGitVerseApp = () => {
    if (!gitverseApp) {
      const selfService = getGitVerseSelfService({ required: true });
      gitverseApp = createGitVerseApp({
        config: resolvedGitVerseOAuthConfig,
        selfService,
        fetchImpl
      });
    }
    return gitverseApp;
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, { ok: true, service: "peerivo-reviewer-integrations", version: "0.5.0" });
      }
      if (req.method === "GET" && url.pathname === "/") {
        return html(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Peerivo Reviewer</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:12vh auto;padding:0 24px;line-height:1.55}h1{font-size:2.4rem;margin-bottom:.3rem}p{color:#333}code{background:#f4f4f5;padding:.15rem .35rem;border-radius:.3rem}a{color:inherit;font-weight:650}</style><h1>Peerivo Reviewer</h1><p>Source-transparent integration shell for GitHub, GitLab and GitVerse pull/merge-request security review. It reads bounded repository metadata and never executes reviewed project code.</p><p><a href="/connect/gitlab">Connect GitLab</a> · <a href="/connect/gitverse">Connect GitVerse</a></p><p>Webhooks: <code>/webhooks/github</code>, <code>/webhooks/gitlab</code> and <code>/webhooks/gitverse/&lt;repository-id&gt;</code></p>`);
      }

      if (req.method === "GET" && url.pathname === "/connect/gitlab") {
        const runtime = getGitLabSelfService({ required: true });
        return redirect(res, runtime.beginOAuth());
      }

      if (req.method === "GET" && url.pathname === "/oauth/gitlab/callback") {
        if (url.searchParams.get("error")) {
          return html(res, 400, "<h1>GitLab authorization was not completed.</h1><p>You can return and start the connection again.</p>", { privateResponse: true });
        }
        const runtime = getGitLabSelfService({ required: true });
        const result = await runtime.completeOAuth({
          code: url.searchParams.get("code") || "",
          state: url.searchParams.get("state") || ""
        });
        const maxAge = Math.floor((resolvedOAuthConfig?.installSessionTtlMs || 60 * 60 * 1000) / 1000);
        return redirect(res, "/gitlab/projects", {
          status: 303,
          headers: { "set-cookie": sessionCookie(result.sessionToken, maxAge) }
        });
      }

      if (req.method === "GET" && url.pathname === "/gitlab/projects") {
        const runtime = getGitLabSelfService({ required: true });
        const sessionToken = parseCookie(req, GITLAB_SESSION_COOKIE);
        const selection = await runtime.projectSelection(sessionToken);
        return html(res, 200, projectsPage(selection, { updated: url.searchParams.get("updated") === "1" }), { privateResponse: true });
      }

      if (req.method === "POST" && url.pathname === "/gitlab/projects") {
        const runtime = getGitLabSelfService({ required: true });
        const sessionToken = parseCookie(req, GITLAB_SESSION_COOKIE);
        const form = new URLSearchParams((await readBody(req, MAX_FORM_BYTES)).toString("utf8"));
        await runtime.applyProjects({
          sessionToken,
          csrf: form.get("csrf") || "",
          projectIds: form.getAll("project")
        });
        return redirect(res, "/gitlab/projects?updated=1", { status: 303 });
      }

      if (req.method === "POST" && url.pathname === "/gitlab/disconnect") {
        const runtime = getGitLabSelfService({ required: true });
        const sessionToken = parseCookie(req, GITLAB_SESSION_COOKIE);
        const form = new URLSearchParams((await readBody(req, MAX_FORM_BYTES)).toString("utf8"));
        await runtime.disconnect({ sessionToken, csrf: form.get("csrf") || "" });
        return redirect(res, "/", {
          status: 303,
          headers: { "set-cookie": clearSessionCookie() }
        });
      }

      if (req.method === "GET" && url.pathname === "/connect/gitverse") {
        const runtime = getGitVerseSelfService({ required: true });
        return redirect(res, runtime.beginOAuth());
      }

      if (req.method === "GET" && url.pathname === "/oauth/gitverse/callback") {
        if (url.searchParams.get("error")) {
          return html(res, 400, "<h1>GitVerse authorization was not completed.</h1><p>You can return and start the connection again.</p>", { privateResponse: true });
        }
        const runtime = getGitVerseSelfService({ required: true });
        const result = await runtime.completeOAuth({
          code: url.searchParams.get("code") || "",
          state: url.searchParams.get("state") || ""
        });
        const maxAge = Math.floor((resolvedGitVerseOAuthConfig?.installSessionTtlMs || 60 * 60 * 1000) / 1000);
        return redirect(res, "/gitverse/repositories", {
          status: 303,
          headers: { "set-cookie": gitverseSessionCookie(result.sessionToken, maxAge) }
        });
      }

      if (req.method === "GET" && url.pathname === "/gitverse/repositories") {
        const runtime = getGitVerseSelfService({ required: true });
        const sessionToken = parseCookie(req, GITVERSE_SESSION_COOKIE);
        const selection = await runtime.repositorySelection(sessionToken);
        return html(res, 200, repositoriesPage(selection, {
          updated: url.searchParams.get("updated") === "1",
          access: url.searchParams.get("access") || "",
          error: url.searchParams.get("error") || ""
        }), { privateResponse: true });
      }

      if (req.method === "POST" && url.pathname === "/gitverse/repositories") {
        const runtime = getGitVerseSelfService({ required: true });
        const sessionToken = parseCookie(req, GITVERSE_SESSION_COOKIE);
        const form = new URLSearchParams((await readBody(req, MAX_FORM_BYTES)).toString("utf8"));
        try {
          const result = await runtime.applyRepositories({
            sessionToken,
            csrf: form.get("csrf") || "",
            repositoryIds: form.getAll("repository"),
            hardGateRepositoryIds: form.has("hard_gate_all") ? form.getAll("repository") : [],
            promoCode: form.get("promo_code") || ""
          });
          const modes = new Set((result.access || []).map(item => item.mode));
          const access = modes.has("promo") ? "promo" : modes.has("trial") ? "trial" : modes.size ? "active" : "";
          const suffix = access ? `&access=${encodeURIComponent(access)}` : "";
          return redirect(res, `/gitverse/repositories?updated=1${suffix}`, { status: 303 });
        } catch (error) {
          if (error?.code === "checkout_required") {
            return redirect(res, "/gitverse/repositories?error=checkout_required", { status: 303 });
          }
          if (error?.code === "promo_invalid" || (form.get("promo_code") && [404, 409, 410].includes(error?.status))) {
            return redirect(res, "/gitverse/repositories?error=promo_invalid", { status: 303 });
          }
          if (error?.status === 402 || error?.status === 403) {
            return redirect(res, "/gitverse/repositories?error=license_required", { status: 303 });
          }
          throw error;
        }
      }

      if (req.method === "POST" && url.pathname === "/v1/ci/gitverse/review") {
        const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
        const gateToken = match?.[1]?.trim() || "";
        if (!gateToken) return plain(res, 401, "Peerivo Reviewer: GitVerse hard-gate token is required.\n");

        const rawBody = await readBody(req, 64 * 1024);
        let request;
        try {
          request = JSON.parse(rawBody.toString("utf8"));
        } catch {
          return plain(res, 400, "Peerivo Reviewer: invalid CI request JSON.\n");
        }

        const repository = String(request?.repository || "").trim();
        const pullNumber = Number(request?.pullNumber);
        const headSha = String(request?.headSha || "").toLowerCase();
        if (!/^[^/\s]+\/[^/\s]+$/.test(repository)
            || !Number.isSafeInteger(pullNumber) || pullNumber < 1
            || !/^[0-9a-f]{40}$/.test(headSha)) {
          return plain(res, 400, "Peerivo Reviewer: invalid GitVerse CI request.\n");
        }

        const selfService = getGitVerseSelfService({ required: true });
        const authContext = selfService.authenticateCiGate({ fullName: repository, token: gateToken });
        const result = await getGitVerseApp().handleWebhook({
          deliveryId: `ci-${headSha.slice(0, 24)}`,
          payload: { pull_request: { number: pullNumber } },
          authContext,
          expectedHeadSha: headSha,
          includeReport: true
        });
        if (!result.accepted) {
          return plain(res, 409, `Peerivo Reviewer: review not accepted (${result.reason || "unknown"}).\n`);
        }
        return plain(res, result.failed ? 422 : 200, String(result.report || "Peerivo Reviewer completed.\n"));
      }

      if (req.method === "POST" && url.pathname === "/gitverse/disconnect") {
        const runtime = getGitVerseSelfService({ required: true });
        const sessionToken = parseCookie(req, GITVERSE_SESSION_COOKIE);
        const form = new URLSearchParams((await readBody(req, MAX_FORM_BYTES)).toString("utf8"));
        await runtime.disconnect({ sessionToken, csrf: form.get("csrf") || "" });
        return redirect(res, "/", {
          status: 303,
          headers: { "set-cookie": clearGitVerseSessionCookie() }
        });
      }

      if (req.method === "POST" && url.pathname === "/webhooks/github") {
        const runtime = getGithubApp();
        const rawBody = await readBody(req);
        if (!runtime.verify(rawBody, req.headers["x-hub-signature-256"])) {
          return json(res, 401, { ok: false, error: "invalid webhook signature" });
        }

        let payload;
        try {
          payload = JSON.parse(rawBody.toString("utf8"));
        } catch {
          return json(res, 400, { ok: false, error: "invalid JSON" });
        }

        const event = String(req.headers["x-github-event"] || "");
        const deliveryId = String(req.headers["x-github-delivery"] || "");
        if (event !== "pull_request") {
          return json(res, 202, { ok: true, accepted: false, reason: "event_not_used" });
        }

        Promise.resolve()
          .then(() => runtime.handleWebhook({ event, deliveryId, payload }))
          .catch(error => backgroundFailure(error, deliveryId));

        return json(res, 202, { ok: true, accepted: true, deliveryId: deliveryId || null });
      }

      if (req.method === "POST" && url.pathname === "/v1/ci/gitlab/review") {
        const jobToken = String(req.headers["job-token"] || "").trim();
        if (!jobToken) return plain(res, 401, "Peerivo Reviewer: GitLab CI job token is required.\n");

        const rawBody = await readBody(req, 64 * 1024);
        let request;
        try {
          request = JSON.parse(rawBody.toString("utf8"));
        } catch {
          return plain(res, 400, "Peerivo Reviewer: invalid CI request JSON.\n");
        }

        const result = await getGitLabCiBridge().review({ jobToken, request });
        const status = result.failed ? 422 : 200;
        return plain(res, status, formatGitLabCiConsoleResult(result));
      }

      if (req.method === "POST" && url.pathname === "/webhooks/gitlab") {
        const runtime = getGitLabApp();
        const rawBody = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(rawBody.toString("utf8"));
        } catch {
          return json(res, 400, { ok: false, error: "invalid JSON" });
        }

        const event = String(req.headers["x-gitlab-event"] || "");
        const deliveryId = String(
          req.headers["webhook-id"]
          || req.headers["x-gitlab-webhook-uuid"]
          || req.headers["idempotency-key"]
          || ""
        );
        if (event !== "Merge Request Hook") {
          return json(res, 202, { ok: true, accepted: false, reason: "event_not_used" });
        }

        const authContext = runtime.authenticateWebhook({
          tokenHeader: req.headers["x-gitlab-token"],
          payload
        });

        Promise.resolve()
          .then(() => runtime.handleWebhook({ event, deliveryId, payload, authContext }))
          .catch(error => backgroundFailure(error, deliveryId));

        return json(res, 202, { ok: true, accepted: true, deliveryId: deliveryId || null });
      }

      if (req.method === "POST" && /^\/webhooks\/gitverse\/[1-9][0-9]*$/.test(url.pathname)) {
        const runtime = getGitVerseApp();
        const repositoryId = Number(url.pathname.split("/").pop());
        if (!Number.isSafeInteger(repositoryId)) {
          return json(res, 400, { ok: false, error: "invalid repository id" });
        }
        const rawBody = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(rawBody.toString("utf8"));
        } catch {
          return json(res, 400, { ok: false, error: "invalid JSON" });
        }

        const deliveryId = String(
          req.headers["x-gitverse-delivery"]
          || req.headers["x-request-id"]
          || req.headers["idempotency-key"]
          || ""
        );
        const authContext = runtime.authenticateWebhook({
          repositoryId,
          authorizationHeader: req.headers.authorization
        });

        Promise.resolve()
          .then(() => runtime.handleWebhook({
            deliveryId,
            payload,
            authContext,
            authorizationHeader: req.headers.authorization,
            repositoryId
          }))
          .catch(error => backgroundFailure(error, deliveryId));

        return json(res, 202, { ok: true, accepted: true, deliveryId: deliveryId || null });
      }

      return json(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      const status = Number.isSafeInteger(error?.status) ? error.status : 503;
      const message = status >= 500 ? "integration is not configured or request failed closed" : error.message;
      process.stderr.write(`Reviewer request failed closed (${error?.name || "Error"})\n`);
      return json(res, status, { ok: false, error: message });
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const serverConfig = loadServerConfig();
    const gitlabOAuthConfig = loadGitLabOAuthConfigOptional();
    const gitverseOAuthConfig = loadGitVerseOAuthConfigOptional();
    const gitverseSelfService = gitverseOAuthConfig
      ? createGitVerseSelfService({ config: gitverseOAuthConfig })
      : null;
    const server = createServer({ gitlabOAuthConfig, gitverseOAuthConfig, gitverseSelfService });
    server.listen(serverConfig.port, serverConfig.host, () => {
      process.stdout.write(`Peerivo Reviewer integrations listening on ${serverConfig.host}:${serverConfig.port}\n`);

      const catalogOwner = String(process.env.GITLAB_CATALOG_BOOTSTRAP_OWNER || "").trim();
      if (catalogOwner && gitlabOAuthConfig) {
        bootstrapGitLabCatalog({
          oauthConfig: gitlabOAuthConfig,
          ownerUsername: catalogOwner,
          projectPath: String(process.env.GITLAB_CATALOG_BOOTSTRAP_PROJECT || "peerivo-reviewer").trim(),
          version: String(process.env.GITLAB_CATALOG_BOOTSTRAP_VERSION || "1.0.0").trim()
        }).then(result => {
          process.stdout.write(`GitLab Catalog bootstrap completed: ${JSON.stringify(result)}\n`);
        }).catch(error => {
          process.stderr.write(`GitLab Catalog bootstrap failed: ${error?.stack || error}\n`);
        });
      }

      const repairRepository = String(process.env.GITVERSE_REPAIR_REPOSITORY || "").trim();
      if (repairRepository && gitverseSelfService) {
        const branches = String(process.env.GITVERSE_REPAIR_BRANCHES || "")
          .split(",")
          .map(value => value.trim())
          .filter(Boolean);
        const touchContent = String(process.env.GITVERSE_REPAIR_TOUCH_CONTENT || "").trim();
        gitverseSelfService.repairRepository({
          fullName: repairRepository,
          branches,
          workflowPath: GITVERSE_REVIEWER_WORKFLOW_PATH,
          workflowContent: GITVERSE_REVIEWER_WORKFLOW,
          touchPath: ".reviewer/gitverse-repair.txt",
          touchContent: touchContent ? touchContent + "\n" : "",
          hardGate: /^(?:1|true|yes)$/i.test(String(process.env.GITVERSE_REPAIR_HARD_GATE || ""))
        }).then(async result => {
          process.stdout.write(`GitVerse repair completed: ${JSON.stringify(result)}\n`);

          const pullNumber = Number(process.env.GITVERSE_REPAIR_PULL || "");
          if (Number.isSafeInteger(pullNumber) && pullNumber > 0) {
            const record = gitverseSelfService.store.getRepository(result.repositoryId);
            if (!record) throw new Error("GitVerse repair repository record disappeared before review");
            const app = createGitVerseApp({
              config: gitverseOAuthConfig,
              selfService: gitverseSelfService
            });
            const reviewResult = await app.handleWebhook({
              deliveryId: `repair-${Date.now()}`,
              payload: { pull_request: { number: pullNumber } },
              authContext: {
                source: "oauth",
                repositoryId: record.repositoryId,
                fullName: record.fullName,
                installationId: record.installationId
              },
              repositoryId: record.repositoryId
            });
            process.stdout.write(`GitVerse repair review completed: ${JSON.stringify(reviewResult)}\n`);
          }
        }).catch(error => {
          process.stderr.write(`GitVerse repair failed: ${error?.stack || error}\n`);
        });
      }
    });
  } catch (error) {
    process.stderr.write(`Peerivo Reviewer integrations failed to start: ${error?.stack || error}\n`);
    process.exitCode = 2;
  }
}
