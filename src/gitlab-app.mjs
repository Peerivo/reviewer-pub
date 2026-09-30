import { verifySharedSecret } from "./crypto.mjs";
import { GitLabClient } from "./gitlab.mjs";
import { collectGitLabReviewPayload, shouldReviewGitLabMergeRequest, submitReview } from "./reviewer.mjs";

function requiredWebhookIdentity(payload, allowedProjects) {
  const projectId = payload?.project?.id;
  const repo = payload?.project?.path_with_namespace;
  const pullNumber = payload?.object_attributes?.iid;
  const targetProjectId = payload?.object_attributes?.target_project_id;

  if (!Number.isSafeInteger(projectId) || projectId < 1) throw new Error("webhook is missing project.id");
  if (typeof repo !== "string" || !/^[^/\s]+(?:\/[^/\s]+)+$/.test(repo)) throw new Error("webhook is missing project.path_with_namespace");
  if (!allowedProjects.has(repo)) throw Object.assign(new Error("GitLab project is not enabled for Reviewer"), { status: 403 });
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new Error("webhook is missing merge request iid");
  if (targetProjectId !== undefined && targetProjectId !== projectId) throw new Error("webhook target project mismatch");

  return { projectId, repo, pullNumber };
}

export function createGitLabApp({ config, fetchImpl = fetch }) {
  const gitlab = new GitLabClient({
    baseUrl: config.gitlabBaseUrl,
    token: config.gitlabToken,
    fetchImpl
  });

  return {
    verify(tokenHeader) {
      return verifySharedSecret({
        secret: config.gitlabWebhookSecret,
        supplied: typeof tokenHeader === "string" ? tokenHeader : ""
      });
    },

    async handleWebhook({ event, deliveryId, payload }) {
      if (event !== "Merge Request Hook" || payload?.object_kind !== "merge_request") {
        return { accepted: false, reason: "event_not_used" };
      }
      if (!shouldReviewGitLabMergeRequest(payload)) return { accepted: false, reason: "action_not_used" };

      const { projectId, repo, pullNumber } = requiredWebhookIdentity(payload, config.gitlabProjects);
      const mr = await gitlab.mergeRequest(repo, pullNumber);
      if (mr?.target_project_id !== projectId) throw new Error("GitLab merge request target project mismatch");
      const headSha = mr?.diff_refs?.head_sha;
      if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/i.test(headSha)) throw new Error("GitLab returned invalid merge request head SHA");
      const statusProjectId = Number.isSafeInteger(mr?.source_project_id) && mr.source_project_id > 0
        ? mr.source_project_id
        : projectId;
      const ref = typeof mr?.source_branch === "string" ? mr.source_branch : "";
      const targetUrl = typeof mr?.web_url === "string" ? mr.web_url : "";

      await gitlab.setCommitStatus(statusProjectId, headSha, {
        state: "pending",
        description: "Peerivo Reviewer is collecting authoritative merge-request security metadata.",
        ref,
        targetUrl
      });

      try {
        const reviewPayload = await collectGitLabReviewPayload({
          gitlab,
          repo,
          pullNumber,
          maxFiles: config.maxFiles,
          maxWorkflows: config.maxWorkflows,
          maxWorkflowBytes: config.maxWorkflowBytes,
          maxSecurityFiles: config.maxSecurityFiles,
          maxSecurityFileBytes: config.maxSecurityFileBytes,
          maxSecurityBytes: config.maxSecurityBytes
        });
        if (reviewPayload.headSha !== headSha.toLowerCase()) {
          throw new Error("merge request head changed during collection; retry on the new update webhook");
        }

        const review = await submitReview({
          apiUrl: config.reviewerApiUrl,
          apiToken: config.reviewerApiToken,
          payload: reviewPayload,
          gitlabProjectId: projectId,
          gitlabDeliveryId: deliveryId,
          timeoutMs: config.reviewTimeoutMs,
          fetchImpl
        });

        await gitlab.setCommitStatus(statusProjectId, headSha, {
          state: review.failed ? "failed" : "success",
          description: review.failed
            ? `Peerivo Reviewer found ${review.findings.length} finding(s); blocking threshold reached.`
            : `Peerivo Reviewer passed; ${review.findings.length} finding(s).`,
          ref,
          targetUrl
        });

        return { accepted: true, repo, pullNumber, reviewId: review.reviewId, failed: review.failed };
      } catch (error) {
        await gitlab.setCommitStatus(statusProjectId, headSha, {
          state: "failed",
          description: "Peerivo Reviewer failed closed because complete review coverage could not be proven.",
          ref,
          targetUrl
        });
        throw error;
      }
    }
  };
}
