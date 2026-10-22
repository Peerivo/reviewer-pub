import { collectReviewPayload } from "./reviewer.mjs";
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
