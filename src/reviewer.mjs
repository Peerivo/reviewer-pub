const WORKFLOW_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const KNOWN_BINARY_RE = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|7z|woff2?|ttf|otf|mp3|mp4|mov|avi|webm|so|dll|dylib|exe|bin)$/i;
const RUNTIME_PROFILE = ".reviewer/external-runtime-security.json";

function isSaasSecurityRelevantPath(path) {
  return path === RUNTIME_PROFILE
    || /(?:^|\/)(?:Dockerfile)(?:\.[^/]*)?$/i.test(path)
    || /(?:^|\/)(?:docker-compose|compose)(?:\.[^/]*)?\.ya?ml$/i.test(path)
    || /(?:^|\/)(?:api|server|backend|src\/server|routes?|controllers?|handlers?)(?:\/|\.|$)/i.test(path)
    || /\.(?:sql|ya?ml|json|js|mjs|cjs|ts|tsx|jsx|py|php|go|cs|java|rb)$/i.test(path);
}

function fullSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${label} is not a full commit SHA`);
  return value.toLowerCase();
}

function filePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
}

export function shouldReviewPullRequestAction(action) {
  return ["opened", "reopened", "synchronize", "ready_for_review"].includes(String(action));
}

export async function collectReviewPayload({
  github,
  repo,
  pullNumber,
  token,
  maxFiles,
  maxWorkflows,
  maxWorkflowBytes,
  maxSecurityFiles = 200,
  maxSecurityFileBytes = 512 * 1024,
  maxSecurityBytes = 4 * 1024 * 1024
}) {
  const pr = await github.pullRequest(repo, pullNumber, token);
  const baseSha = fullSha(pr?.base?.sha, "base SHA");
  const headSha = fullSha(pr?.head?.sha, "head SHA");
  const authoritativeRepo = pr?.base?.repo?.full_name;
  if (authoritativeRepo !== repo) throw new Error("pull request repository identity mismatch");

  const files = await github.pullFiles(repo, pullNumber, token, { maxFiles });
  const allFiles = await github.tree(repo, headSha, token, { maxFiles });
  const changes = files.map(item => {
    if (!filePath(item?.filename)) throw new Error("GitHub returned an invalid changed file path");
    const patch = typeof item.patch === "string" ? item.patch : "";
    if (!patch && item.status !== "removed" && !KNOWN_BINARY_RE.test(item.filename)) {
      throw new Error(`GitHub omitted the patch for ${item.filename}; review fails closed because coverage is incomplete`);
    }
    return {
      status: String(item.status || "modified"),
      path: item.filename,
      patch
    };
  });

  const workflowPaths = allFiles.filter(path => WORKFLOW_RE.test(path));
  if (workflowPaths.length > maxWorkflows) throw new Error(`repository exceeds MAX_WORKFLOWS (${maxWorkflows})`);
  const workflows = [];
  let totalWorkflowBytes = 0;
  for (const path of workflowPaths) {
    const content = await github.fileContent(repo, path, headSha, token, { maxBytes: maxWorkflowBytes });
    totalWorkflowBytes += Buffer.byteLength(content);
    if (totalWorkflowBytes > maxWorkflowBytes) throw new Error("combined workflow content exceeds MAX_WORKFLOW_BYTES");
    workflows.push({ path, content });
  }

  const securityPaths = [...new Set([
    ...changes.filter(item => isSaasSecurityRelevantPath(item.path)).map(item => item.path),
    ...(allFiles.includes(RUNTIME_PROFILE) ? [RUNTIME_PROFILE] : [])
  ])];
  if (securityPaths.length > maxSecurityFiles) {
    throw new Error(`security snapshot exceeds MAX_SECURITY_FILES (${maxSecurityFiles})`);
  }

  async function optionalContent(path, sha) {
    try {
      return await github.fileContent(repo, path, sha, token, { maxBytes: maxSecurityFileBytes });
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
  }

  let totalSecurityBytes = 0;
  const securityFiles = [];
  for (const path of securityPaths) {
    const headContent = await optionalContent(path, headSha);
    const baseContent = await optionalContent(path, baseSha);
    totalSecurityBytes += Buffer.byteLength(headContent || "") + Buffer.byteLength(baseContent || "");
    if (totalSecurityBytes > maxSecurityBytes) {
      throw new Error(`security snapshot exceeds MAX_SECURITY_BYTES (${maxSecurityBytes})`);
    }
    securityFiles.push({ path, headContent, baseContent });
  }

  return {
    schemaVersion: 1,
    platform: "github",
    repository: repo,
    pullRequest: pullNumber,
    baseSha,
    headSha,
    visibility: pr?.base?.repo?.visibility || (pr?.base?.repo?.private ? "private" : "public"),
    allFiles,
    changes,
    workflows,
    securityFiles
  };
}

export function validateReviewerResponse(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) throw new Error("Reviewer returned an invalid schema");
  if (typeof value.reviewId !== "string" || !value.reviewId) throw new Error("Reviewer response is missing reviewId");
  if (typeof value.failed !== "boolean") throw new Error("Reviewer response is missing failed");
  if (!Array.isArray(value.findings)) throw new Error("Reviewer response is missing findings");
  if (typeof value.report !== "string") throw new Error("Reviewer response is missing report");
  return value;
}

export async function submitReview({ apiUrl, apiToken, payload, installationId, deliveryId, timeoutMs, fetchImpl = fetch }) {
  const response = await fetchImpl(`${apiUrl}/v1/reviews`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "user-agent": "Peerivo-Reviewer-GitHub-App/0.1",
      "x-peerivo-github-installation-id": String(installationId),
      "x-peerivo-github-delivery-id": String(deliveryId || "")
    },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`Reviewer returned non-JSON (${response.status})`); }
  if (!response.ok) throw new Error(`Reviewer failed closed (${response.status}): ${body?.message || "request failed"}`);
  return validateReviewerResponse(body);
}
