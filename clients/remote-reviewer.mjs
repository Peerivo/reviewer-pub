#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
  const maxSecurityFileBytes = positiveSafeInteger(process.env.PEERIVO_MAX_SECURITY_FILE_BYTES, 512 * 1024, "PEERIVO_MAX_SECURITY_FILE_BYTES");
  const maxSecurityBytes = positiveSafeInteger(process.env.PEERIVO_MAX_SECURITY_BYTES, 4 * 1024 * 1024, "PEERIVO_MAX_SECURITY_BYTES");
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
    ...(files.includes(".reviewer/external-runtime-security.json") ? [".reviewer/external-runtime-security.json"] : [])
  ])];
  if (securityPaths.length > maxSecurityFiles) {
    throw new Error(`Security-file count ${securityPaths.length} exceeds fail-closed limit ${maxSecurityFiles}`);
  }
  let securityBytes = 0;
  const securityFiles = securityPaths.map((path) => {
    const headContent = fileAt("HEAD", path);
    const baseContent = fileAt(baseSha, path);
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
  if (result?.schemaVersion !== 1 || typeof result?.failed !== "boolean" || typeof result?.report !== "string") {
    throw new Error("Reviewer API returned an invalid response schema");
  }

  process.stdout.write(result.report + "\n");
  if (result.failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Peerivo Reviewer thin client failed closed: ${error?.stack || error}\n`);
    process.exitCode = 2;
  });
}
