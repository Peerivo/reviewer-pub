import { verifyWebhookSignature } from "./crypto.mjs";
import { GitHubClient } from "./github.mjs";
import { collectReviewPayload, shouldReviewPullRequestAction, submitReview } from "./reviewer.mjs";

const CHECK_NAME = "Peerivo Reviewer";

function truncate(text, max = 60000) {
  const value = String(text || "");
  return value.length <= max ? value : `${value.slice(0, max)}\n\n…truncated`;
}

function requiredWebhookIdentity(payload) {
  const installationId = payload?.installation?.id;
  const repo = payload?.repository?.full_name;
  const pullNumber = payload?.pull_request?.number;
  if (!Number.isSafeInteger(installationId) || installationId < 1) throw new Error("webhook is missing installation.id");
  if (typeof repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("webhook is missing repository.full_name");
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new Error("webhook is missing pull_request.number");
  return { installationId, repo, pullNumber };
}

export function createApp({ config, fetchImpl = fetch }) {
  const github = new GitHubClient({ appId: config.githubAppId, privateKey: config.githubPrivateKey, fetchImpl });

  return {
    health() {
      return { ok: true, service: "peerivo-reviewer-github-app", version: "0.4.0" };
    },

    verify(rawBody, signatureHeader) {
      return verifyWebhookSignature({ secret: config.githubWebhookSecret, rawBody, signatureHeader });
    },

    async handleWebhook({ event, deliveryId, payload }) {
      if (event !== "pull_request") return { accepted: false, reason: "event_not_used" };
      if (!shouldReviewPullRequestAction(payload?.action)) return { accepted: false, reason: "action_not_used" };

      const { installationId, repo, pullNumber } = requiredWebhookIdentity(payload);
      const token = await github.installationToken(installationId);
      const pr = await github.pullRequest(repo, pullNumber, token);
      const headSha = pr?.head?.sha;
      if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/i.test(headSha)) throw new Error("GitHub returned invalid PR head SHA");

      const check = await github.createCheck(repo, token, {
        name: CHECK_NAME,
        head_sha: headSha,
        status: "in_progress",
        external_id: `delivery:${deliveryId || "unknown"};pr:${pullNumber}`,
        output: {
          title: "Peerivo Reviewer is checking this pull request",
          summary: "The GitHub App is collecting bounded authoritative diff/workflow/security metadata. Reviewed project code is not executed."
        }
      });
      const checkId = check?.id;
      if (!Number.isSafeInteger(checkId) || checkId < 1) throw new Error("GitHub did not return a check run id");

      try {
        const reviewPayload = await collectReviewPayload({
          github,
          repo,
          pullNumber,
          token,
          maxFiles: config.maxFiles,
          maxWorkflows: config.maxWorkflows,
          maxWorkflowBytes: config.maxWorkflowBytes,
          maxSecurityFiles: config.maxSecurityFiles,
          maxSecurityFileBytes: config.maxSecurityFileBytes,
          maxSecurityBytes: config.maxSecurityBytes
        });
        if (reviewPayload.headSha !== headSha.toLowerCase()) throw new Error("PR head changed during collection; retry on the new synchronize webhook");

        const review = await submitReview({
          apiUrl: config.reviewerApiUrl,
          apiToken: config.reviewerApiToken,
          payload: reviewPayload,
          installationId,
          deliveryId,
          timeoutMs: config.reviewTimeoutMs,
          fetchImpl
        });

        await github.updateCheck(repo, checkId, token, {
          status: "completed",
          conclusion: review.failed ? "failure" : "success",
          completed_at: new Date().toISOString(),
          output: {
            title: review.failed ? "Peerivo Reviewer found blocking issues" : "Peerivo Reviewer passed",
            summary: truncate(review.report),
            text: `Review ID: ${review.reviewId}\nFindings: ${review.findings.length}`
          }
        });
        return { accepted: true, repo, pullNumber, reviewId: review.reviewId, failed: review.failed };
      } catch (error) {
        await github.updateCheck(repo, checkId, token, {
          status: "completed",
          conclusion: "failure",
          completed_at: new Date().toISOString(),
          output: {
            title: "Peerivo Reviewer failed closed",
            summary: truncate(`The review could not prove complete coverage and therefore did not pass.\n\n${error?.message || error}`)
          }
        });
        throw error;
      }
    }
  };
}
