import { collectGitVerseReviewPayload, shouldReviewGitVersePullRequest, submitReview } from "./reviewer.mjs";

const COMMENT_MARKER = "<!-- peerivo-reviewer -->";

function truncate(value, max = 50000) {
  const text = String(value || "");
  return text.length <= max ? text : text.slice(0, max) + "\n\n…truncated";
}

function webhookPullNumber(payload) {
  const pullNumber = payload?.pull_request?.number
    ?? payload?.pullRequest?.number
    ?? payload?.number
    ?? payload?.issue?.number;

  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) {
    throw Object.assign(new Error("webhook is missing pull request number"), { status: 400 });
  }
  return pullNumber;
}

async function upsertComment(gitverse, repo, pullNumber, body) {
  const comments = await gitverse.listComments(repo, pullNumber);
  const existing = [...comments].reverse().find(comment =>
    Number.isSafeInteger(comment?.id)
    && typeof comment?.body === "string"
    && comment.body.includes(COMMENT_MARKER)
  );
  if (existing) return gitverse.updateComment(repo, pullNumber, existing.id, body);
  return gitverse.createComment(repo, pullNumber, body);
}

export function pendingBody() {
  return [
    COMMENT_MARKER,
    "> [!NOTE]",
    "> **Review in progress**"
  ].join("\n");
}

export function resultBody(review, changedFiles = null) {
  const findings = Array.isArray(review?.findings) ? review.findings.length : 0;
  const files = Number.isSafeInteger(changedFiles) && changedFiles >= 0 ? changedFiles : null;
  const summary = files === null
    ? `${findings} finding${findings === 1 ? "" : "s"}`
    : `${findings} finding${findings === 1 ? "" : "s"} · ${files} file${files === 1 ? "" : "s"} reviewed`;

  return [
    COMMENT_MARKER,
    review.failed ? "> [!CAUTION]" : "> [!TIP]",
    review.failed ? "> **⛔ BLOCKED**" : "> **✅ PASS**",
    summary,
    "",
    "<details>",
    "<summary>View Peerivo Reviewer details</summary>",
    "",
    truncate(review.report),
    "",
    "</details>"
  ].join("\n");
}

export function failClosedBody() {
  return [
    COMMENT_MARKER,
    "> [!WARNING]",
    "> **⚠️ REVIEW FAILED CLOSED**"
  ].join("\n");
}

export function createGitVerseApp({ config, selfService, fetchImpl = fetch }) {
  if (!selfService) throw new Error("GitVerse self-service runtime is required");

  return {
    authenticateWebhook({ repositoryId, authorizationHeader }) {
      const connected = selfService.authenticateRepositoryWebhook({
        repositoryId,
        authorizationHeader
      });
      if (!connected) throw Object.assign(new Error("GitVerse repository is not enabled for Reviewer"), { status: 403 });
      return connected;
    },

    async handleWebhook({ deliveryId = "", payload, authContext = null, authorizationHeader = "", repositoryId = null }) {
      if (!shouldReviewGitVersePullRequest(payload)) return { accepted: false, reason: "action_not_used" };
      const authenticated = authContext || this.authenticateWebhook({ repositoryId, authorizationHeader });
      const pullNumber = webhookPullNumber(payload);
      const { repositoryId: installedRepositoryId, fullName: repo } = authenticated;
      const gitverse = await selfService.gitverseForInstallation(authenticated.installationId);

      const pr = await gitverse.pullRequest(repo, pullNumber);
      if (pr?.state !== "open") return { accepted: false, reason: "pull_request_not_open" };
      const headSha = String(pr?.head?.sha || "").toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("GitVerse returned invalid PR head SHA");

      await upsertComment(gitverse, repo, pullNumber, pendingBody());

      try {
        const reviewPayload = await collectGitVerseReviewPayload({
          gitverse,
          repo,
          pullNumber,
          maxFiles: config.maxFiles,
          maxWorkflows: config.maxWorkflows,
          maxWorkflowBytes: config.maxWorkflowBytes,
          maxSecurityFiles: config.maxSecurityFiles,
          maxSecurityFileBytes: config.maxSecurityFileBytes,
          maxSecurityBytes: config.maxSecurityBytes
        });
        if (reviewPayload.headSha !== headSha) {
          throw new Error("GitVerse pull request head changed during collection");
        }

        const review = await submitReview({
          apiUrl: config.reviewerApiUrl,
          apiToken: config.reviewerApiToken,
          payload: reviewPayload,
          gitverseRepositoryId: installedRepositoryId,
          gitverseDeliveryId: deliveryId,
          timeoutMs: config.reviewTimeoutMs,
          fetchImpl
        });

        await upsertComment(gitverse, repo, pullNumber, resultBody(review, reviewPayload.changes.length));
        return { accepted: true, repo, pullNumber, reviewId: review.reviewId, failed: review.failed };
      } catch (error) {
        try { await upsertComment(gitverse, repo, pullNumber, failClosedBody()); } catch {}
        throw error;
      }
    }
  };
}
