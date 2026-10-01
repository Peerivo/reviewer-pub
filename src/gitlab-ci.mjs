import { GitLabClient } from "./gitlab.mjs";
import { collectGitLabReviewPayload, submitReview } from "./reviewer.mjs";

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw Object.assign(new Error(`invalid ${label}`), { status: 400 });
  }
  return id;
}

function fullSha(value, label) {
  const sha = String(value || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw Object.assign(new Error(`invalid ${label}`), { status: 400 });
  }
  return sha;
}

export function validateGitLabCiRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("invalid GitLab CI review request"), { status: 400 });
  }
  return {
    projectId: positiveId(value.projectId, "project id"),
    mergeRequestIid: positiveId(value.mergeRequestIid, "merge request iid"),
    pipelineId: positiveId(value.pipelineId, "pipeline id"),
    jobId: positiveId(value.jobId, "job id"),
    sha: fullSha(value.sha, "commit SHA")
  };
}

export function createGitLabCiBridge({ config, selfService, fetchImpl = fetch } = {}) {
  if (!config) throw new Error("GitLab CI bridge config is required");
  if (!selfService) throw new Error("GitLab CI bridge requires GitLab self-service runtime");

  return {
    async review({ jobToken, request }) {
      const token = String(jobToken || "").trim();
      if (!token) throw Object.assign(new Error("GitLab CI job token is required"), { status: 401 });

      const input = validateGitLabCiRequest(request);
      const installed = selfService.store.getProject(input.projectId);
      if (!installed) {
        throw Object.assign(new Error("GitLab project is not connected to Peerivo Reviewer"), { status: 403 });
      }

      const jobClient = new GitLabClient({
        baseUrl: config.gitlabBaseUrl,
        token,
        authMode: "job-token",
        fetchImpl
      });
      const job = await jobClient.currentJob();

      if (Number(job?.id) !== input.jobId) {
        throw Object.assign(new Error("GitLab CI job identity mismatch"), { status: 403 });
      }
      if (Number(job?.project?.id) !== input.projectId) {
        throw Object.assign(new Error("GitLab CI project identity mismatch"), { status: 403 });
      }
      if (Number(job?.pipeline?.id) !== input.pipelineId) {
        throw Object.assign(new Error("GitLab CI pipeline identity mismatch"), { status: 403 });
      }
      if (fullSha(job?.commit?.id, "job commit SHA") !== input.sha) {
        throw Object.assign(new Error("GitLab CI commit identity mismatch"), { status: 403 });
      }

      const gitlab = await selfService.gitlabForInstallation(installed.installationId);
      const project = await gitlab.project(input.projectId);
      if (Number(project?.id) !== input.projectId || project?.path_with_namespace !== installed.pathWithNamespace) {
        throw Object.assign(new Error("GitLab connected project identity mismatch"), { status: 403 });
      }

      const mr = await gitlab.mergeRequest(installed.pathWithNamespace, input.mergeRequestIid);
      if (mr?.state !== "opened") throw Object.assign(new Error("GitLab merge request is not open"), { status: 409 });
      if (Number(mr?.target_project_id) !== input.projectId) {
        throw Object.assign(new Error("GitLab merge request target project mismatch"), { status: 403 });
      }
      const headSha = fullSha(mr?.diff_refs?.head_sha, "merge request head SHA");
      if (headSha !== input.sha) {
        throw Object.assign(new Error("GitLab CI commit is not the current merge request head"), { status: 409 });
      }
      if (mr?.head_pipeline?.id !== undefined && mr?.head_pipeline?.id !== null) {
        if (Number(mr.head_pipeline.id) !== input.pipelineId) {
          throw Object.assign(new Error("GitLab CI pipeline is not the current merge request pipeline"), { status: 409 });
        }
      }

      const reviewPayload = await collectGitLabReviewPayload({
        gitlab,
        repo: installed.pathWithNamespace,
        pullNumber: input.mergeRequestIid,
        maxFiles: config.maxFiles,
        maxWorkflows: config.maxWorkflows,
        maxWorkflowBytes: config.maxWorkflowBytes,
        maxSecurityFiles: config.maxSecurityFiles,
        maxSecurityFileBytes: config.maxSecurityFileBytes,
        maxSecurityBytes: config.maxSecurityBytes
      });
      if (reviewPayload.headSha !== input.sha) {
        throw Object.assign(new Error("merge request head changed during review collection"), { status: 409 });
      }

      const review = await submitReview({
        apiUrl: config.reviewerApiUrl,
        apiToken: config.reviewerApiToken,
        payload: reviewPayload,
        gitlabProjectId: input.projectId,
        gitlabDeliveryId: `ci-${input.jobId}`,
        timeoutMs: config.reviewTimeoutMs,
        fetchImpl
      });

      return {
        ...review,
        projectId: input.projectId,
        mergeRequestIid: input.mergeRequestIid,
        pipelineId: input.pipelineId,
        jobId: input.jobId,
        sha: input.sha
      };
    }
  };
}
