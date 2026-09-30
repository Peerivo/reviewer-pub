import http from "node:http";
import { createApp } from "./app.mjs";
import { createGitLabApp } from "./gitlab-app.mjs";
import { createGitLabSelfService } from "./gitlab-self-service.mjs";
import { loadConfig, loadGitLabConfig, loadGitLabOAuthConfigOptional, loadServerConfig } from "./config.mjs";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const MAX_FORM_BYTES = 256 * 1024;
const GITLAB_SESSION_COOKIE = "peerivo_gitlab_install";

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

function backgroundFailure(error, deliveryId) {
  const kind = error?.name || "Error";
  process.stderr.write(`Reviewer delivery ${deliveryId || "unknown"} failed closed (${kind})\n`);
}

export function createServer({
  config,
  gitlabConfig,
  gitlabOAuthConfig,
  gitlabSelfService,
  fetchImpl = fetch
} = {}) {
  let githubApp;
  let gitlabApp;
  let selfService = gitlabSelfService || null;
  let oauthConfigResolved = gitlabOAuthConfig !== undefined;
  let resolvedOAuthConfig = gitlabOAuthConfig ?? null;

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

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, { ok: true, service: "peerivo-reviewer-integrations", version: "0.4.0" });
      }
      if (req.method === "GET" && url.pathname === "/") {
        return html(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Peerivo Reviewer</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:12vh auto;padding:0 24px;line-height:1.55}h1{font-size:2.4rem;margin-bottom:.3rem}p{color:#333}code{background:#f4f4f5;padding:.15rem .35rem;border-radius:.3rem}a{color:inherit;font-weight:650}</style><h1>Peerivo Reviewer</h1><p>Source-transparent integration shell for GitHub and GitLab pull/merge-request security review. It reads bounded repository metadata, never executes reviewed project code, and publishes provider-native status.</p><p><a href="/connect/gitlab">Connect GitLab</a></p><p>Webhooks: <code>/webhooks/github</code> and <code>/webhooks/gitlab</code></p>`);
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
    const server = createServer();
    server.listen(serverConfig.port, serverConfig.host, () => {
      process.stdout.write(`Peerivo Reviewer integrations listening on ${serverConfig.host}:${serverConfig.port}\n`);
    });
  } catch (error) {
    process.stderr.write(`Peerivo Reviewer integrations failed to start: ${error?.stack || error}\n`);
    process.exitCode = 2;
  }
}
