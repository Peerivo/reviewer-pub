import { verifySharedSecret } from "./crypto.mjs";
import { GitLabClient } from "./gitlab.mjs";
import { collectGitLabReviewPayload, shouldReviewGitLabMergeRequest, submitReview } from "./reviewer.mjs";

export function gitLabStatusDescription({ state, findings = 0 }) {
  const count = Number.isSafeInteger(findings) && findings >= 0 ? findings : 0;
  if (state === "pending") return "Review in progress";
  if (state === "failed_closed") return "Failed closed";
  if (state === "blocked") return `Blocked — ${count} finding${count === 1 ? "" : "s"}`;
  return `Passed — ${count} finding${count === 1 ? "" : "s"}`;
}

function requiredWebhookIdentity(payload) {
  const projectId = payload?.project?.id;
  const repo = payload?.project?.path_with_namespace;
  const pullNumber = payload?.object_attributes?.iid;
  const targetProjectId = payload?.object_attributes?.target_project_id;

  if (!Number.isSafeInteger(projectId) || projectId < 1) throw Object.assign(new Error("webhook is missing project.id"), { status: 400 });
  if (typeof repo !== "string" || !/^[^/\s]+(?:\/[^/\s]+)+$/.test(repo)) {
    throw Object.assign(new Error("webhook is missing project.path_with_namespace"), { status: 400 });
  }
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw Object.assign(new Error("webhook is missing merge request iid"), { status: 400 });
  if (targetProjectId !== undefined && targetProjectId !== projectId) {
    throw Object.assign(new Error("webhook target project mismatch"), { status: 400 });
  }

  return { projectId, repo, pullNumber };
}

export function createGitLabApp({ config, selfService = null, fetchImpl = fetch }) {
  function legacyClient() {
    if (!config.legacyEnabled || !config.gitlabToken) {
      throw Object.assign(new Error("GitLab project is not enabled for Reviewer"), { status: 403 });
    }
    return new GitLabClient({
      baseUrl: config.gitlabBaseUrl,
      token: config.gitlabToken,
      fetchImpl
    });
  }

  return {
    authenticateWebhook({ tokenHeader, payload }) {
      const identity = requiredWebhookIdentity(payload);

      if (selfService) {
        const connected = selfService.authenticateProjectWebhook({
          projectId: identity.projectId,
          repo: identity.repo,
          tokenHeader
        });
        if (connected) return { ...identity, ...connected };
      }

      if (!config.legacyEnabled || !config.gitlabProjects.has(identity.repo)) {
        throw Object.assign(new Error("GitLab project is not enabled for Reviewer"), { status: 403 });
      }
      if (!verifySharedSecret({
        secret: config.gitlabWebhookSecret,
        supplied: typeof tokenHeader === "string" ? tokenHeader : ""
      })) {
        throw Object.assign(new Error("invalid webhook token"), { status: 401 });
      }
      return { ...identity, source: "legacy" };
    },

    async handleWebhook({ event, deliveryId, payload, authContext = null, tokenHeader = "" }) {
      if (event !== "Merge Request Hook" || payload?.object_kind !== "merge_request") {
        return { accepted: false, reason: "event_not_used" };
      }
      if (!shouldReviewGitLabMergeRequest(payload)) return { accepted: false, reason: "action_not_used" };

      const authenticated = authContext || this.authenticateWebhook({ tokenHeader, payload });
      const { projectId, repo, pullNumber } = authenticated;
      const gitlab = authenticated.source === "oauth"
        ? await selfService.gitlabForInstallation(authenticated.installationId)
        : legacyClient();

      const mr = await gitlab.mergeRequest(repo, pullNumber);
      if (mr?.target_project_id !== projectId) throw new Error("GitLab merge request target project mismatch");
      const headSha = mr?.diff_refs?.head_sha;
      if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/i.test(headSha)) throw new Error("GitLab returned invalid merge request head SHA");
      const statusProjectId = Number.isSafeInteger(mr?.source_project_id) && mr.source_project_id > 0
        ? mr.source_project_id
        : projectId;
      const ref = typeof mr?.source_branch === "string" ? mr.source_branch : "";
      const targetUrl = typeof mr?.web_url === "string" ? mr.web_url : "";
      const headPipelineId = Number.isSafeInteger(mr?.head_pipeline?.id)
        && mr.head_pipeline.id > 0
        && Number(mr?.head_pipeline?.project_id) === statusProjectId
        && String(mr?.head_pipeline?.sha || "").toLowerCase() === headSha.toLowerCase()
        ? mr.head_pipeline.id
        : null;

      await gitlab.setCommitStatus(statusProjectId, headSha, {
        state: "pending",
        description: gitLabStatusDescription({ state: "pending" }),
        ref,
        targetUrl,
        pipelineId: headPipelineId
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
          description: gitLabStatusDescription({
            state: review.failed ? "blocked" : "passed",
            findings: review.findings.length
          }),
          ref,
          targetUrl,
          pipelineId: headPipelineId
        });

        return { accepted: true, repo, pullNumber, reviewId: review.reviewId, failed: review.failed };
      } catch (error) {
        await gitlab.setCommitStatus(statusProjectId, headSha, {
          state: "failed",
          description: gitLabStatusDescription({ state: "failed_closed" }),
          ref,
          targetUrl,
          pipelineId: headPipelineId
        });
        throw error;
      }
    }
  };
}
