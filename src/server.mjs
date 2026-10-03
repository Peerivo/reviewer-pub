import fs from "node:fs";
import http from "node:http";
import { createInstallationExperience } from "./installation-experience.mjs";
import { errorPage, uiLanguage } from "./installation-ui.mjs";
import { providerPaths, selectedRecords } from "./installation-status.mjs";
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
const REVIEWER_LOGO = fs.readFileSync(new URL("../assets/reviewer-logo.jpg", import.meta.url));

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
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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

  const installationExperience = createInstallationExperience({
    runtimeFor(provider) {
      const service = provider === "gitlab"
        ? getGitLabSelfService({ required: true }) : getGitVerseSelfService({ required: true });
      const config = provider === "gitlab" ? resolvedOAuthConfig : resolvedGitVerseOAuthConfig;
      return { service, config };
    },
    html, redirect, readBody, parseCookie
  });

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/assets/reviewer-logo.jpg") {
        res.writeHead(200, { "content-type": "image/jpeg", "content-length": REVIEWER_LOGO.length, "cache-control": "public, max-age=86400, immutable", "x-content-type-options": "nosniff" });
        res.end(REVIEWER_LOGO);
        return;
      }
      if (await installationExperience(req, res, url)) return;
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, { ok: true, service: "peerivo-reviewer-integrations", version: "0.5.0" });
      }
      if (req.method === "GET" && url.pathname === "/connect/gitlab") {
        const runtime = getGitLabSelfService({ required: true });
        const existing = runtime.store.getSessionInstallation(parseCookie(req, "peerivo_gitlab_install"));
        if (existing && url.searchParams.get("reauthorize") !== "1") {
          const paths = providerPaths("gitlab");
          return redirect(res, selectedRecords("gitlab", runtime, existing.id).length ? paths.connected : paths.manage, { status: 303 });
        }
        return redirect(res, runtime.beginOAuth());
      }

      if (req.method === "GET" && url.pathname === "/oauth/gitlab/callback") {
        if (url.searchParams.get("error")) {
          return html(res, 400, errorPage("gitlab", { lang: uiLanguage(req), status: 400, cancelled: true }), { privateResponse: true });
        }
        const runtime = getGitLabSelfService({ required: true });
        const result = await runtime.completeOAuth({
          code: url.searchParams.get("code") || "",
          state: url.searchParams.get("state") || ""
        });
        const maxAge = Math.floor((resolvedOAuthConfig?.installSessionTtlMs || 60 * 60 * 1000) / 1000);
        const destination = selectedRecords("gitlab", runtime, result.installationId).length ? "/gitlab/connected" : "/gitlab/projects";
        return redirect(res, destination, {
          status: 303,
          headers: { "set-cookie": sessionCookie(result.sessionToken, maxAge) }
        });
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
        const existing = runtime.store.getSessionInstallation(parseCookie(req, "peerivo_gitverse_install"));
        if (existing && url.searchParams.get("reauthorize") !== "1") {
          const paths = providerPaths("gitverse");
          return redirect(res, selectedRecords("gitverse", runtime, existing.id).length ? paths.connected : paths.manage, { status: 303 });
        }
        return redirect(res, runtime.beginOAuth());
      }

      if (req.method === "GET" && url.pathname === "/oauth/gitverse/callback") {
        if (url.searchParams.get("error")) {
          return html(res, 400, errorPage("gitverse", { lang: uiLanguage(req), status: 400, cancelled: true }), { privateResponse: true });
        }
        const runtime = getGitVerseSelfService({ required: true });
        const result = await runtime.completeOAuth({
          code: url.searchParams.get("code") || "",
          state: url.searchParams.get("state") || ""
        });
        const maxAge = Math.floor((resolvedGitVerseOAuthConfig?.installSessionTtlMs || 60 * 60 * 1000) / 1000);
        const destination = selectedRecords("gitverse", runtime, result.installationId).length ? "/gitverse/connected" : "/gitverse/repositories";
        return redirect(res, destination, {
          status: 303,
          headers: { "set-cookie": gitverseSessionCookie(result.sessionToken, maxAge) }
        });
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
      const browserRoute = new URL(req.url || "/", "http://localhost").pathname.match(/^\/(?:connect|oauth)\/(gitlab|gitverse)(?:\/callback)?$/);
      if (browserRoute) return html(res, status, errorPage(browserRoute[1], { lang: uiLanguage(req), status }), { privateResponse: true });
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
