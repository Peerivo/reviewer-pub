import { collectReviewPayload, submitReview } from "./reviewer.mjs";
const SHA = /^[a-f0-9]{40}$/i;
export function validatePushEvent(payload, repository) {
  if (!repository || payload?.repository?.full_name !== repository.full_name) throw new Error("push repository mismatch");
  if (!Number.isSafeInteger(payload?.installation?.id) || payload.installation.id < 1) throw new Error("missing installation");
  if (payload.ref !== "refs/heads/" + repository.default_branch) return null;
  if (payload.created || payload.deleted) return null;
  for (const key of ["before","after"]) {
    const value = payload[key];
    if (!SHA.test(value || "") || /^0{40}$/.test(value)) throw new Error("invalid push range");
  }
  if (payload.forced) throw new Error("forced push needs independent audit");
  return { before: payload.before.toLowerCase(), after: payload.after.toLowerCase() };
}
export async function collectPushReviewPayload({github, repo, token, before, after, visibility, config}) {
  const comparison = await github.compareCommits(repo, before, after, token);
  if (comparison.status !== "ahead" || comparison.merge_base_commit?.sha !== before ||
      comparison.base_commit?.sha !== before) throw new Error("invalid push comparison");
  if (!Array.isArray(comparison.files) || comparison.files.length >= 300 ||
      comparison.files.length > config.maxFiles) throw new Error("GitHub compare list may be truncated");
  const wrapper = {
    pullRequest: async () => ({base:{sha:before,repo:{full_name:repo,visibility}},head:{sha:after}}),
    pullFiles: async () => comparison.files,
    tree: (...args) => github.tree(...args),
    fileContent: (...args) => github.fileContent(...args)
  };
  const result = await collectReviewPayload({
    github: wrapper, repo, pullNumber: null, token, maxFiles: config.maxFiles,
    maxWorkflows: config.maxWorkflows, maxWorkflowBytes: config.maxWorkflowBytes,
    maxSecurityFiles: config.maxSecurityFiles, maxSecurityFileBytes: config.maxSecurityFileBytes,
    maxSecurityBytes: config.maxSecurityBytes
  });
  return { ...result, pullRequest: null };
}

export async function handleDefaultBranchPush({ github, config, payload, deliveryId = "", submit = submitReview }) {
  const repo = String(payload?.repository?.full_name || "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("invalid push repository");
  const installationId = payload?.installation?.id;
  if (!Number.isSafeInteger(installationId) || installationId < 1) throw new Error("invalid installation");
  const token = await github.installationToken(installationId);
  const repository = await github.repository(repo, token);
  if (payload.ref !== "refs/heads/" + repository.default_branch) return { accepted: false, reason: "not_default_branch" };
  if (payload.created || payload.deleted) return { accepted: false, reason: "initial_or_deleted" };
  if (!/^[a-f0-9]{40}$/i.test(payload.after || "") || /^0{40}$/.test(payload.after)) throw new Error("invalid push head SHA");
  const check = await github.createCheck(repo, token, {
    name: "Peerivo Reviewer", head_sha: payload.after.toLowerCase(), status: "in_progress",
    external_id: "delivery:" + deliveryId + ";push:" + payload.after,
    output: { title: "Direct push security review", summary: "Reviewing default branch committed changes." }
  });
  if (!Number.isSafeInteger(check?.id) || check.id < 1) throw new Error("invalid check-run id");
  try {
    const range = validatePushEvent(payload, repository);
    if (!range) throw new Error("push comparison unavailable");
    const reviewPayload = await collectPushReviewPayload({
      github, repo, token, before: range.before, after: range.after,
      visibility: repository.visibility || (repository.private ? "private" : "public"), config
    });
    const result = await submit({
      apiUrl: config.reviewerApiUrl, apiToken: config.reviewerApiToken,
      payload: reviewPayload, installationId, deliveryId, timeoutMs: config.reviewTimeoutMs
    });
    await github.updateCheck(repo, check.id, token, {
      status: "completed", conclusion: result.failed ? "failure" : "success",
      completed_at: new Date().toISOString(),
      output: { title: result.failed ? "Blocking direct-push findings" : "Direct-push review passed",
        summary: String(result.report || "").slice(0, 60000) }
    });
    return { accepted: true, repo, headSha: range.after, failed: result.failed, reviewId: result.reviewId };
  } catch (error) {
    await github.updateCheck(repo, check.id, token, {
      status: "completed", conclusion: "failure", completed_at: new Date().toISOString(),
      output: { title: "Direct push review incomplete", summary: "Full coverage could not be verified. Inspect the check and rerun a complete audit." }
    });
    throw error;
  }
}
