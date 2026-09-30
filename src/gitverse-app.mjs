import { collectGitVerseReviewPayload, shouldReviewGitVersePullRequest, submitReview } from "./reviewer.mjs";

const COMMENT_MARKER = "<!-- peerivo-reviewer -->";

function truncate(value, max = 50000) {
  const text = String(value || "");
  return text.length <= max ? text : text.slice(0, max) + "\n\n…truncated";
}

function webhookIdentity(payload) {
  const repository = payload?.repository || payload?.repo;
  const repositoryId = repository?.id;
  const fullName = repository?.full_name || repository?.fullName;
  const pullNumber = payload?.pull_request?.number
    ?? payload?.pullRequest?.number
    ?? payload?.number
    ?? payload?.issue?.number;

  if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) {
    throw Object.assign(new Error("webhook is missing repository.id"), { status: 400 });
  }
  if (typeof fullName !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
    throw Object.assign(new Error("webhook is missing repository.full_name"), { status: 400 });
  }
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) {
    throw Object.assign(new Error("webhook is missing pull request number"), { status: 400 });
  }
  return { repositoryId, fullName, pullNumber };
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

function pendingBody(headSha) {
  return [
    COMMENT_MARKER,
    "### Peerivo Reviewer · checking",
    "",
    `Reviewing head \`${headSha}\` from authoritative GitVerse API data.`,
    "",
    "Reviewed project code is not executed."
  ].join("\n");
}

function resultBody(review, headSha) {
  return [
    COMMENT_MARKER,
    review.failed ? "### Peerivo Reviewer · blocking findings" : "### Peerivo Reviewer · passed",
    "",
    `Head: \`${headSha}\``,
    `Review ID: \`${review.reviewId}\``,
    "",
    truncate(review.report)
  ].join("\n");
}

function failClosedBody(headSha) {
  return [
    COMMENT_MARKER,
    "### Peerivo Reviewer · failed closed",
    "",
    `Head: \`${headSha}\``,
    "",
    "Complete review coverage could not be proven, so this review did not pass."
  ].join("\n");
}

export function createGitVerseApp({ config, selfService, fetchImpl = fetch }) {
  if (!selfService) throw new Error("GitVerse self-service runtime is required");

  return {
    authenticateWebhook({ authorizationHeader, payload }) {
      const identity = webhookIdentity(payload);
      const connected = selfService.authenticateRepositoryWebhook({
        repositoryId: identity.repositoryId,
        fullName: identity.fullName,
        authorizationHeader
      });
      if (!connected) throw Object.assign(new Error("GitVerse repository is not enabled for Reviewer"), { status: 403 });
      return { ...identity, ...connected };
    },

    async handleWebhook({ deliveryId = "", payload, authContext = null, authorizationHeader = "" }) {
      if (!shouldReviewGitVersePullRequest(payload)) return { accepted: false, reason: "action_not_used" };
      const authenticated = authContext || this.authenticateWebhook({ authorizationHeader, payload });
      const { repositoryId, fullName: repo, pullNumber } = authenticated;
      const gitverse = await selfService.gitverseForInstallation(authenticated.installationId);

      const pr = await gitverse.pullRequest(repo, pullNumber);
      if (pr?.state !== "open") return { accepted: false, reason: "pull_request_not_open" };
      const headSha = String(pr?.head?.sha || "").toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("GitVerse returned invalid PR head SHA");

      await upsertComment(gitverse, repo, pullNumber, pendingBody(headSha));

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
          gitverseRepositoryId: repositoryId,
          gitverseDeliveryId: deliveryId,
          timeoutMs: config.reviewTimeoutMs,
          fetchImpl
        });

        await upsertComment(gitverse, repo, pullNumber, resultBody(review, headSha));
        return { accepted: true, repo, pullNumber, reviewId: review.reviewId, failed: review.failed };
      } catch (error) {
        try { await upsertComment(gitverse, repo, pullNumber, failClosedBody(headSha)); } catch {}
        throw error;
      }
    }
  };
}
