import http from "node:http";
import { createApp } from "./app.mjs";
import { loadConfig, loadServerConfig } from "./config.mjs";

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

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

function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "public, max-age=300",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_WEBHOOK_BYTES) throw Object.assign(new Error("webhook too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function backgroundFailure(error, deliveryId) {
  const kind = error?.name || "Error";
  process.stderr.write(`Reviewer delivery ${deliveryId || "unknown"} failed closed (${kind})\n`);
}

export function createServer({ config, fetchImpl = fetch } = {}) {
  let app;
  const getApp = () => {
    if (!app) app = createApp({ config: config || loadConfig(), fetchImpl });
    return app;
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, { ok: true, service: "peerivo-reviewer-github-app", version: "0.1.0" });
      }
      if (req.method === "GET" && url.pathname === "/") {
        return html(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Peerivo Reviewer</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:12vh auto;padding:0 24px;line-height:1.55}h1{font-size:2.4rem;margin-bottom:.3rem}p{color:#333}code{background:#f4f4f5;padding:.15rem .35rem;border-radius:.3rem}</style><h1>Peerivo Reviewer</h1><p>GitHub App shell for pull-request security review. The app reads bounded repository metadata, never executes reviewed project code, and publishes a GitHub Check Run.</p><p>Webhook endpoint: <code>/webhooks/github</code></p>`);
      }
      if (req.method === "POST" && url.pathname === "/webhooks/github") {
        const runtime = getApp();
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
      process.stdout.write(`Peerivo Reviewer GitHub App listening on ${serverConfig.host}:${serverConfig.port}\n`);
    });
  } catch (error) {
    process.stderr.write(`Peerivo Reviewer GitHub App failed to start: ${error?.stack || error}\n`);
    process.exitCode = 2;
  }
}
