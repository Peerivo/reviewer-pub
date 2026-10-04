#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ANSI_GREEN = "\u001b[32m";
const ANSI_RED = "\u001b[31m";
const ANSI_RESET = "\u001b[0m";

function compact(value, max = 360) {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function fallbackRemediation(id) {
  const rule = String(id || "").toUpperCase();
  if (/^(?:CI-|SUPPLY-)/.test(rule)) return "Remove the unsafe CI or supply-chain pattern and rerun Peerivo Reviewer.";
  if (/^SEC-/.test(rule)) return "Remove and rotate the credential if real, then use the platform secret store.";
  if (/^DEPS-/.test(rule)) return "Regenerate and commit the lockfile together with the manifest change.";
  if (/^DB-/.test(rule)) return "Add an explicit migration-capable CI execution path.";
  return "Resolve the reported risk and rerun Peerivo Reviewer.";
}

function remoteBlobUrl(platform, repository, sha, path) {
  if (!/^[0-9a-f]{40}$/i.test(String(sha || "")) || !path) return "";
  const repo = String(repository || "").split("/").map(encodeURIComponent).join("/");
  const file = String(path).split("/").map(encodeURIComponent).join("/");
  if (platform === "gitverse") return `https://gitverse.ru/${repo}/blob/${sha}/${file}`;
  if (platform === "github") return `https://github.com/${repo}/blob/${sha}/${file}`;
  return "";
}

export function formatRemoteConsoleResult(result, { platform, repository, headSha, changedFiles = null } = {}) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const blocked = result?.failed === true;
  const lines = [
    blocked
      ? `${ANSI_RED}Peerivo Reviewer — BLOCKED${ANSI_RESET}`
      : `${ANSI_GREEN}Peerivo Reviewer — PASS${ANSI_RESET}`,
    "",
    `Findings: ${findings.length}`,
    Number.isSafeInteger(changedFiles) && changedFiles >= 0 ? `Files reviewed: ${changedFiles}` : null,
    ""
  ].filter(value => value !== null);

  if (findings.length) {
    lines.push("Findings:");
    findings.slice(0, 20).forEach((item, index) => {
      const severity = compact(item?.severity || "info", 32).toUpperCase();
      const id = compact(item?.id || "FINDING", 64);
      const title = compact(item?.title || item?.message || "Reviewer finding", 220);
      const path = compact(item?.path || "", 240);
      const why = compact(item?.message || title);
      const fix = compact(item?.remediation || fallbackRemediation(id));
      const open = remoteBlobUrl(platform, repository, headSha, path);
      lines.push(
        "",
        `  ${index + 1}. ${ANSI_RED}[${severity}] ${id}${ANSI_RESET} ${title}`,
        path ? `     File: ${path}` : null,
        open ? `     Open: ${open}` : null,
        `     Why:  ${why}`,
        `     Fix:  ${fix}`
      );
    });
    if (findings.length > 20) lines.push("", `  … ${findings.length - 20} more finding(s)`);
    lines.push("");
  }

  if (result?.reviewId) lines.push(`Review ID: ${compact(result.reviewId, 120)}`, "");
  return lines.filter(value => value !== null).join("\n");
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });
}

export function positiveSafeInteger(raw, fallback, name) {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function nulTokens(buffer) {
  return buffer.toString("utf8").split("\0").filter((item) => item !== "");
}

export function parseNameStatusTokens(tokens) {
  const changes = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!status) throw new Error("Git diff returned an empty file status");

    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = tokens[i++];
      const path = tokens[i++];
      if (!previousPath || !path) throw new Error(`Git diff returned incomplete ${status} record`);
      changes.push({ status: status.startsWith("R") ? "renamed" : "copied", previousPath, path });
      continue;
    }

    const map = { A: "added", M: "modified", D: "removed", T: "type_changed" };
    const normalized = map[status[0]];
    const path = tokens[i++];
    if (!normalized) throw new Error(`Unsupported Git diff status: ${status}`);
    if (!path) throw new Error(`Git diff returned incomplete ${status} record`);
    changes.push({ status: normalized, path });
  }
  return changes;
}

function changedFiles(baseSha) {
  const tokens = nulTokens(git(["diff", "--name-status", "--find-renames", "-z", `${baseSha}...HEAD`], { encoding: null }));
  return parseNameStatusTokens(tokens);
}

function patchFor(baseSha, file) {
  const args = ["diff", "--no-ext-diff", "--unified=3", `${baseSha}...HEAD`, "--"];
  if (file.previousPath) args.push(file.previousPath);
  args.push(file.path);
  return git(args);
}

function listFiles() {
  return nulTokens(git(["ls-files", "-z"], { encoding: null }));
}

function fileAt(ref, path) {
  try {
    return git(["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

function headFile(path) {
  return fileAt("HEAD", path);
}

function isSaasSecurityRelevantPath(path) {
  return path === ".reviewer/external-runtime-security.json"
    || /(?:^|\/)(?:Dockerfile)(?:\.[^/]*)?$/i.test(path)
    || /(?:^|\/)(?:docker-compose|compose)(?:\.[^/]*)?\.ya?ml$/i.test(path)
    || /(?:^|\/)(?:api|server|backend|src\/server|routes?|controllers?|handlers?)(?:\/|\.|$)/i.test(path)
    || /\.(?:sql|ya?ml|json|js|mjs|cjs|ts|tsx|jsx|py|php|go|cs|java|rb)$/i.test(path);
}


function isOssScannerSupportPath(path) {
  return /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|requirements(?:-[^/]*)?\.txt|poetry\.lock|Pipfile(?:\.lock)?|pyproject\.toml|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle(?:\.kts)?|gradle\.lockfile|composer\.json|composer\.lock|Gemfile(?:\.lock)?|packages\.lock\.json|[^/]+\.(?:csproj|fsproj))$/i.test(path || "");
}

function resolveBase(baseRef) {
  if (!baseRef) throw new Error("PEERIVO_BASE_REF is required");
  if (/^[0-9a-f]{7,40}$/i.test(baseRef)) {
    return git(["rev-parse", `${baseRef}^{commit}`]).trim();
  }
  return git(["merge-base", "HEAD", baseRef]).trim();
}

export async function main() {
  const api = String(process.env.PEERIVO_REVIEWER_API || "").replace(/\/$/, "");
  const token = process.env.PEERIVO_LICENSE || "";
  if (!api || !/^https:\/\//i.test(api)) throw new Error("PEERIVO_REVIEWER_API must be an https:// URL");
  if (!token) throw new Error("PEERIVO_LICENSE is required");

  const maxFiles = positiveSafeInteger(process.env.PEERIVO_MAX_FILES, 1000, "PEERIVO_MAX_FILES");
  const maxPayloadBytes = positiveSafeInteger(process.env.PEERIVO_MAX_PAYLOAD_BYTES, 8 * 1024 * 1024, "PEERIVO_MAX_PAYLOAD_BYTES");
  const maxSecurityFiles = positiveSafeInteger(process.env.PEERIVO_MAX_SECURITY_FILES, 200, "PEERIVO_MAX_SECURITY_FILES");
  const maxSecurityFileBytes = positiveSafeInteger(process.env.PEERIVO_MAX_SECURITY_FILE_BYTES, 4 * 1024 * 1024, "PEERIVO_MAX_SECURITY_FILE_BYTES");
  const maxSecurityBytes = positiveSafeInteger(process.env.PEERIVO_MAX_SECURITY_BYTES, 8 * 1024 * 1024, "PEERIVO_MAX_SECURITY_BYTES");
  const platform = process.env.PEERIVO_PLATFORM || "gitverse";
  if (!["github", "gitverse"].includes(platform)) throw new Error(`Unsupported remote platform: ${platform}`);

  const repository = process.env.GITVERSE_REPOSITORY || process.env.GITHUB_REPOSITORY || "";
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("Repository identity is required in owner/name form");
  }

  const pullRequestRaw = process.env.PEERIVO_PULL_REQUEST || "";
  const pullRequest = pullRequestRaw ? Number(pullRequestRaw) : null;
  if (pullRequest !== null && (!Number.isSafeInteger(pullRequest) || pullRequest < 1)) {
    throw new Error("PEERIVO_PULL_REQUEST must be a positive safe integer");
  }

  const baseSha = resolveBase(process.env.PEERIVO_BASE_REF || "");
  const headSha = git(["rev-parse", "HEAD^{commit}"]).trim();
  const files = listFiles();
  const changes = changedFiles(baseSha);

  if (changes.length > maxFiles) {
    throw new Error(`Changed-file count ${changes.length} exceeds fail-closed limit ${maxFiles}`);
  }

  const reviewChanges = changes.map((file) => ({
    ...file,
    patch: patchFor(baseSha, file)
  }));
  const workflows = files
    .filter((file) => /^(?:\.github|\.gitverse)\/workflows\/.+\.ya?ml$/i.test(file))
    .map((path) => ({ path, content: headFile(path) ?? "" }));

  const securityPaths = [...new Set([
    ...changes.filter((item) => item.status !== "removed" && isSaasSecurityRelevantPath(item.path)).map((item) => item.path),
    ...files.filter(isOssScannerSupportPath),
    ...(files.includes(".reviewer/external-runtime-security.json") ? [".reviewer/external-runtime-security.json"] : [])
  ])];
  if (securityPaths.length > maxSecurityFiles) {
    throw new Error(`Security-file count ${securityPaths.length} exceeds fail-closed limit ${maxSecurityFiles}`);
  }
  const changedSecurityPaths = new Set(changes.map((item) => item.path));
  let securityBytes = 0;
  const securityFiles = securityPaths.map((path) => {
    const headContent = fileAt("HEAD", path);
    const baseContent = changedSecurityPaths.has(path) || path === ".reviewer/external-runtime-security.json"
      ? fileAt(baseSha, path)
      : null;
    for (const [label, value] of [["head", headContent], ["base", baseContent]]) {
      if (value === null) continue;
      const bytes = Buffer.byteLength(value);
      if (bytes > maxSecurityFileBytes) {
        throw new Error(`${path} ${label} content exceeds fail-closed security-file limit of ${maxSecurityFileBytes} bytes`);
      }
      securityBytes += bytes;
      if (securityBytes > maxSecurityBytes) {
        throw new Error(`Security snapshot exceeds fail-closed limit of ${maxSecurityBytes} bytes`);
      }
    }
    return { path, headContent, baseContent };
  });

  const payload = {
    schemaVersion: 1,
    platform,
    repository,
    pullRequest,
    baseSha,
    headSha,
    visibility: process.env.PEERIVO_REPOSITORY_VISIBILITY || null,
    allFiles: files,
    changes: reviewChanges,
    workflows,
    securityFiles
  };

  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > maxPayloadBytes) {
    throw new Error(`Review payload exceeds fail-closed limit of ${maxPayloadBytes} bytes`);
  }

  const response = await fetch(`${api}/v1/reviews`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": "peerivo-reviewer-thin-client/1"
    },
    body,
    signal: AbortSignal.timeout(120_000)
  });

  const raw = await response.text();
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error(`Reviewer API returned non-JSON response (${response.status})`);
  }

  if (!response.ok) {
    throw new Error(`Reviewer API denied review (${response.status}): ${result?.message || result?.reason || "error"}`);
  }
  if (result?.schemaVersion !== 1
    || typeof result?.failed !== "boolean"
    || typeof result?.report !== "string"
    || !Array.isArray(result?.findings)) {
    throw new Error("Reviewer API returned an invalid response schema");
  }

  process.stdout.write(formatRemoteConsoleResult(result, {
    platform,
    repository,
    headSha,
    changedFiles: changes.length
  }) + "\n");
  if (result.failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Peerivo Reviewer thin client failed closed: ${error?.stack || error}\n`);
    process.exitCode = 2;
  });
}
