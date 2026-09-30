function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a safe integer between ${min} and ${max}`);
  }
  return value;
}

function normalizeHttps(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an https:// URL without embedded credentials, query or fragment`);
  }
  return url.origin + url.pathname.replace(/\/$/, "");
}

function httpsUrl(env, name) {
  return normalizeHttps(required(env, name), name);
}

function optionalHttpsUrl(env, name, fallback) {
  return normalizeHttps(String(env[name] || fallback).trim(), name);
}

function repositorySet(env, name) {
  const values = String(required(env, name)).split(",").map(value => value.trim()).filter(Boolean);
  const result = new Set();
  for (const value of values) {
    if (!/^[^/\s]+\/.+[^/\s]$/.test(value)) throw new Error(`${name} contains invalid repository: ${value}`);
    result.add(value);
  }
  if (result.size === 0) throw new Error(`${name} must contain at least one repository`);
  return result;
}

export function loadServerConfig(env = process.env) {
  return Object.freeze({
    port: integer(env, "PORT", 8080, { max: 65535 }),
    host: String(env.HOST || "0.0.0.0")
  });
}

function reviewerConfig(env) {
  return {
    reviewerApiUrl: httpsUrl(env, "REVIEWER_API_URL"),
    reviewerApiToken: required(env, "REVIEWER_API_TOKEN"),
    maxFiles: integer(env, "MAX_FILES", 1000, { max: 100000 }),
    maxWorkflows: integer(env, "MAX_WORKFLOWS", 200, { max: 1000 }),
    maxWorkflowBytes: integer(env, "MAX_WORKFLOW_BYTES", 1024 * 1024, { max: 10 * 1024 * 1024 }),
    maxSecurityFiles: integer(env, "MAX_SECURITY_FILES", 200, { max: 2000 }),
    maxSecurityFileBytes: integer(env, "MAX_SECURITY_FILE_BYTES", 512 * 1024, { max: 4 * 1024 * 1024 }),
    maxSecurityBytes: integer(env, "MAX_SECURITY_BYTES", 4 * 1024 * 1024, { max: 16 * 1024 * 1024 }),
    reviewTimeoutMs: integer(env, "REVIEW_TIMEOUT_MS", 30000, { min: 1000, max: 120000 })
  };
}

export function loadConfig(env = process.env) {
  const privateKey = required(env, "GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
  if (!privateKey.includes("PRIVATE KEY")) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key");

  return Object.freeze({
    ...loadServerConfig(env),
    ...reviewerConfig(env),
    githubAppId: required(env, "GITHUB_APP_ID"),
    githubPrivateKey: privateKey,
    githubWebhookSecret: required(env, "GITHUB_WEBHOOK_SECRET")
  });
}

export function loadGitLabConfig(env = process.env) {
  return Object.freeze({
    ...loadServerConfig(env),
    ...reviewerConfig(env),
    gitlabBaseUrl: optionalHttpsUrl(env, "GITLAB_BASE_URL", "https://gitlab.com"),
    gitlabToken: required(env, "GITLAB_TOKEN"),
    gitlabWebhookSecret: required(env, "GITLAB_WEBHOOK_SECRET"),
    gitlabProjects: repositorySet(env, "GITLAB_PROJECTS")
  });
}
