function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(env, name) {
  const value = String(env[name] || "").trim();
  return value || null;
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

// Public callback/webhook bases must never inherit a development/container address.
// URL parsing canonicalizes abbreviated, decimal and hexadecimal loopback IPv4 forms.
// This is configuration validation, not DNS resolution or an SSRF protection boundary.
function publicHttpsUrl(env, name) {
  const value = httpsUrl(env, name);
  const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  const host = hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host.endsWith(".localhost")
    || host === "localhost.localdomain" || host === "0.0.0.0" || host.startsWith("127.")
    || host === "::" || host === "::1" || host.startsWith("::ffff:")
    || host === "host.docker.internal" || host === "gateway.docker.internal";
  if (local) throw new Error(`${name} must use a public host, not a local, loopback or container URL`);
  return value;
}

function optionalHttpsUrl(env, name, fallback) {
  return normalizeHttps(String(env[name] || fallback).trim(), name);
}

function repositorySet(raw, name) {
  const values = String(raw || "").split(",").map(value => value.trim()).filter(Boolean);
  const result = new Set();
  for (const value of values) {
    if (!/^[^/\s]+(?:\/[^/\s]+)+$/.test(value)) throw new Error(`${name} contains invalid repository: ${value}`);
    result.add(value);
  }
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
    maxSecurityFileBytes: integer(env, "MAX_SECURITY_FILE_BYTES", 4 * 1024 * 1024, { max: 4 * 1024 * 1024 }),
    maxSecurityBytes: integer(env, "MAX_SECURITY_BYTES", 8 * 1024 * 1024, { max: 16 * 1024 * 1024 }),
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
  const gitlabToken = optional(env, "GITLAB_TOKEN");
  const gitlabWebhookSecret = optional(env, "GITLAB_WEBHOOK_SECRET");
  const rawProjects = optional(env, "GITLAB_PROJECTS");
  const configured = [gitlabToken, gitlabWebhookSecret, rawProjects].filter(Boolean).length;
  if (configured !== 0 && configured !== 3) {
    throw new Error("legacy GitLab mode requires GITLAB_TOKEN, GITLAB_WEBHOOK_SECRET and GITLAB_PROJECTS together");
  }
  const gitlabProjects = repositorySet(rawProjects, "GITLAB_PROJECTS");
  if (configured === 3 && gitlabProjects.size === 0) throw new Error("GITLAB_PROJECTS must contain at least one repository");

  return Object.freeze({
    ...loadServerConfig(env),
    ...reviewerConfig(env),
    gitlabBaseUrl: optionalHttpsUrl(env, "GITLAB_BASE_URL", "https://gitlab.com"),
    gitlabToken,
    gitlabWebhookSecret,
    gitlabProjects,
    legacyEnabled: configured === 3
  });
}

export function loadGitLabOAuthConfig(env = process.env) {
  const publicUrl = publicHttpsUrl(env, "GITLAB_PUBLIC_URL");
  const tokenEncryptionKey = required(env, "GITLAB_TOKEN_ENCRYPTION_KEY");
  if (Buffer.byteLength(tokenEncryptionKey) < 32) {
    throw new Error("GITLAB_TOKEN_ENCRYPTION_KEY must contain at least 32 bytes");
  }
  return Object.freeze({
    gitlabBaseUrl: optionalHttpsUrl(env, "GITLAB_BASE_URL", "https://gitlab.com"),
    oauthClientId: required(env, "GITLAB_OAUTH_CLIENT_ID"),
    oauthClientSecret: required(env, "GITLAB_OAUTH_CLIENT_SECRET"),
    oauthRedirectUri: `${publicUrl}/oauth/gitlab/callback`,
    webhookUrl: `${publicUrl}/webhooks/gitlab`,
    installationsDb: required(env, "GITLAB_INSTALLATIONS_DB"),
    tokenEncryptionKey,
    oauthStateTtlMs: integer(env, "GITLAB_OAUTH_STATE_TTL_MS", 10 * 60 * 1000, { min: 60_000, max: 60 * 60 * 1000 }),
    installSessionTtlMs: integer(env, "GITLAB_INSTALL_SESSION_TTL_MS", 30 * 24 * 60 * 60 * 1000, { min: 5 * 60 * 1000, max: 90 * 24 * 60 * 60 * 1000 }),
    maxDiscoverProjects: integer(env, "GITLAB_MAX_DISCOVER_PROJECTS", 1000, { min: 1, max: 5000 }),
    maxInstallProjects: integer(env, "GITLAB_MAX_INSTALL_PROJECTS", 100, { min: 1, max: 1000 })
  });
}

export function loadGitLabOAuthConfigOptional(env = process.env) {
  const names = [
    "GITLAB_OAUTH_CLIENT_ID",
    "GITLAB_OAUTH_CLIENT_SECRET",
    "GITLAB_PUBLIC_URL",
    "GITLAB_INSTALLATIONS_DB",
    "GITLAB_TOKEN_ENCRYPTION_KEY"
  ];
  if (!names.some(name => String(env[name] || "").trim())) return null;
  return loadGitLabOAuthConfig(env);
}

export function loadGitVerseOAuthConfig(env = process.env) {
  const publicUrl = publicHttpsUrl(env, "GITVERSE_PUBLIC_URL");
  const tokenEncryptionKey = required(env, "GITVERSE_TOKEN_ENCRYPTION_KEY");
  if (Buffer.byteLength(tokenEncryptionKey) < 32) {
    throw new Error("GITVERSE_TOKEN_ENCRYPTION_KEY must contain at least 32 bytes");
  }
  return Object.freeze({
    ...reviewerConfig(env),
    webBaseUrl: optionalHttpsUrl(env, "GITVERSE_WEB_BASE_URL", "https://gitverse.ru"),
    apiBaseUrl: optionalHttpsUrl(env, "GITVERSE_API_BASE_URL", "https://api.gitverse.ru"),
    oauthClientId: required(env, "GITVERSE_OAUTH_CLIENT_ID"),
    oauthClientSecret: required(env, "GITVERSE_OAUTH_CLIENT_SECRET"),
    oauthRedirectUri: `${publicUrl}/oauth/gitverse/callback`,
    webhookUrl: `${publicUrl}/webhooks/gitverse`,
    installationsDb: required(env, "GITVERSE_INSTALLATIONS_DB"),
    tokenEncryptionKey,
    oauthStateTtlMs: integer(env, "GITVERSE_OAUTH_STATE_TTL_MS", 10 * 60 * 1000, { min: 60_000, max: 60 * 60 * 1000 }),
    installSessionTtlMs: integer(env, "GITVERSE_INSTALL_SESSION_TTL_MS", 30 * 24 * 60 * 60 * 1000, { min: 5 * 60 * 1000, max: 90 * 24 * 60 * 60 * 1000 }),
    maxDiscoverRepositories: integer(env, "GITVERSE_MAX_DISCOVER_REPOSITORIES", 1000, { min: 1, max: 5000 }),
    maxInstallRepositories: integer(env, "GITVERSE_MAX_INSTALL_REPOSITORIES", 100, { min: 1, max: 1000 })
  });
}

export function loadGitVerseOAuthConfigOptional(env = process.env) {
  const names = [
    "GITVERSE_OAUTH_CLIENT_ID",
    "GITVERSE_OAUTH_CLIENT_SECRET",
    "GITVERSE_PUBLIC_URL",
    "GITVERSE_INSTALLATIONS_DB",
    "GITVERSE_TOKEN_ENCRYPTION_KEY"
  ];
  if (!names.some(name => String(env[name] || "").trim())) return null;
  return loadGitVerseOAuthConfig(env);
}
