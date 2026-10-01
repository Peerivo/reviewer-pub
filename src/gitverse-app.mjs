import { collectGitVerseReviewPayload, shouldReviewGitVersePullRequest, submitReview } from "./reviewer.mjs";

const COMMENT_MARKER = "<!-- peerivo-reviewer -->";

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

function repoPath(repo) {
  return String(repo || "").split("/").map(encodeURIComponent).join("/");
}

export function gitVerseChecksUrl(webBaseUrl, repo, pullNumber) {
  const base = String(webBaseUrl || "https://gitverse.ru").replace(/\/$/, "");
  return base + "/" + repoPath(repo) + "/pulls/" + pullNumber + "/checks";
}

function compact(value, max = 180) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").trim();
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function fallbackRemediation(id) {
  const rule = String(id || "").toUpperCase();
  if (/^(?:CI-|SUPPLY-)/.test(rule)) return "Remove the unsafe CI or supply-chain pattern and rerun Peerivo Reviewer.";
  if (/^SEC-/.test(rule)) return "Remove and rotate the credential if real, then use the platform secret store.";
  if (/^DEPS-/.test(rule)) return "Regenerate and commit the lockfile together with the manifest change.";
  if (/^DB-/.test(rule)) return "Add an explicit migration-capable CI execution path.";
  if (/^PUBLIC-/.test(rule)) return "Remove the material from the public repository or move it to an approved private location.";
  return "Resolve the reported risk and rerun Peerivo Reviewer.";
}

export function gitVerseBlobUrl(webBaseUrl, repo, sha, path) {
  const base = String(webBaseUrl || "https://gitverse.ru").replace(/\/$/, "");
  const commit = String(sha || "").toLowerCase();
  const file = String(path || "").trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || !file) return "";
  const encodedPath = file.split("/").map(encodeURIComponent).join("/");
  return base + "/" + repoPath(repo) + "/blob/" + commit + "/" + encodedPath;
}

function findingBlock(item, index, { webBaseUrl = "", repo = "", headSha = "" } = {}) {
  const severity = String(item?.severity || "info").toUpperCase();
  const id = compact(item?.id || "FINDING", 64);
  const title = compact(item?.title || item?.message || "Reviewer finding");
  const path = compact(item?.path || "", 200).replace(/`/g, "'");
  const why = compact(item?.message || title, 360);
  const fix = compact(item?.remediation || fallbackRemediation(id), 360);
  const open = gitVerseBlobUrl(webBaseUrl, repo, headSha, path);
  const lines = [
    "**" + index + ". " + severity + " · " + id + " — " + title + "**"
  ];
  if (path) {
    lines.push(open
      ? "- **File:** [" + path + "](" + open + ")"
      : "- **File:** `" + path + "`");
  }
  lines.push("- **Why:** " + why);
  lines.push("- **Fix:** " + fix);
  return lines.join("\n");
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

function checkLink(checkUrl) {
  return checkUrl ? "**CI:** [Open Peerivo Reviewer check](" + checkUrl + ")" : "";
}

export function pendingBody({ checkUrl = "" } = {}) {
  return [
    COMMENT_MARKER,
    "> [!NOTE]",
    "> **Peerivo Reviewer — review in progress**",
    "",
    checkLink(checkUrl)
  ].filter(Boolean).join("\n");
}

export function resultBody(review, changedFiles = null, {
  checkUrl = "",
  webBaseUrl = "",
  repo = "",
  headSha = ""
} = {}) {
  const items = Array.isArray(review?.findings) ? review.findings : [];
  const findings = items.length;
  const files = Number.isSafeInteger(changedFiles) && changedFiles >= 0 ? changedFiles : null;
  const summary = files === null
    ? findings + " finding" + (findings === 1 ? "" : "s")
    : findings + " finding" + (findings === 1 ? "" : "s") + " · " + files + " file" + (files === 1 ? "" : "s") + " reviewed";

  const body = [
    COMMENT_MARKER,
    review.failed ? "> [!CAUTION]" : "> [!TIP]",
    review.failed ? "> **⛔ BLOCKED**" : "> **✅ PASS**",
    "> " + summary
  ];

  if (review.failed && findings > 0) {
    body.push("", "**Findings & fixes**");
    items.slice(0, 3).forEach((item, index) => {
      body.push("", findingBlock(item, index + 1, { webBaseUrl, repo, headSha }));
    });
    if (findings > 3) body.push("", "+" + (findings - 3) + " more in the Reviewer check.");
  }

  if (checkUrl) body.push("", "---", checkLink(checkUrl));
  return body.join("\n");
}

export function failClosedBody({ checkUrl = "" } = {}) {
  return [
    COMMENT_MARKER,
    "> [!WARNING]",
    "> **⚠️ REVIEW FAILED CLOSED**",
    "",
    checkLink(checkUrl)
  ].filter(Boolean).join("\n");
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
      const checkUrl = gitVerseChecksUrl(config.webBaseUrl, repo, pullNumber);

      const pr = await gitverse.pullRequest(repo, pullNumber);
      if (pr?.state !== "open") return { accepted: false, reason: "pull_request_not_open" };
      const headSha = String(pr?.head?.sha || "").toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("GitVerse returned invalid PR head SHA");

      await upsertComment(gitverse, repo, pullNumber, pendingBody({ checkUrl }));

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

        await upsertComment(
          gitverse,
          repo,
          pullNumber,
          resultBody(review, reviewPayload.changes.length, {
            checkUrl,
            webBaseUrl: config.webBaseUrl,
            repo,
            headSha
          })
        );
        return { accepted: true, repo, pullNumber, reviewId: review.reviewId, failed: review.failed };
      } catch (error) {
        try { await upsertComment(gitverse, repo, pullNumber, failClosedBody({ checkUrl })); } catch {}
        throw error;
      }
    }
  };
}
