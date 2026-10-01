import test from "node:test";
import assert from "node:assert/strict";
import { gitLabStatusDescription } from "../src/gitlab-app.mjs";
import { pendingBody, resultBody, failClosedBody, gitVerseBlobUrl, gitVerseChecksUrl } from "../src/gitverse-app.mjs";

test("GitLab status stays compact and Reviewer-branded", () => {
  assert.equal(gitLabStatusDescription({ state: "pending" }), "Review in progress");
  assert.equal(gitLabStatusDescription({ state: "passed", findings: 0 }), "Passed — 0 findings");
  assert.equal(gitLabStatusDescription({ state: "blocked", findings: 2 }), "Blocked — 2 findings");
  assert.equal(gitLabStatusDescription({ state: "failed_closed" }), "Failed closed");
});

test("GitVerse checks link targets the PR checks tab", () => {
  assert.equal(
    gitVerseChecksUrl("https://gitverse.ru", "olegka85/tesst", 2),
    "https://gitverse.ru/olegka85/tesst/pulls/2/checks"
  );
});

test("GitVerse blob link targets the reviewed commit and file", () => {
  assert.equal(
    gitVerseBlobUrl("https://gitverse.ru", "acme/widget", "a".repeat(40), ".gitverse/workflows/ci.yml"),
    "https://gitverse.ru/acme/widget/blob/" + "a".repeat(40) + "/.gitverse/workflows/ci.yml"
  );
});

test("GitVerse PASS card stays compact and links to the full check", () => {
  const pass = resultBody({
    failed: false,
    findings: [],
    report: "FULL DETAILS THAT MUST STAY IN CHECKS"
  }, 2, { checkUrl: "https://gitverse.ru/acme/widget/pulls/42/checks" });

  assert.match(pass, /✅ PASS/);
  assert.match(pass, /0 findings · 2 files reviewed/);
  assert.match(pass, /Open Peerivo Reviewer check/);
  assert.doesNotMatch(pass, /FULL DETAILS/);
  assert.doesNotMatch(pass, /Technical details/);
  assert.doesNotMatch(pass, /<details>/);
});

test("GitVerse BLOCKED card shows compact findings and links to full check", () => {
  const blocked = resultBody({
    failed: true,
    findings: [
      {
        id: "FC-001",
        severity: "high",
        title: "Security-relevant numeric input defaults to zero before validation",
        message: "A missing numeric value becomes zero before the policy decision.",
        remediation: "Validate the numeric input explicitly before applying policy.",
        path: "security-gate.js"
      },
      {
        id: "CI-004",
        severity: "high",
        title: "Unpinned Action",
        message: "A third-party Action uses a mutable tag.",
        remediation: "Pin the third-party Action to a full immutable commit SHA.",
        path: ".gitverse/workflows/ci.yml"
      },
      { id: "CI-005", severity: "medium", title: "Another finding", path: "ci.yml" },
      { id: "CI-006", severity: "low", title: "Fourth finding", path: "other.yml" }
    ],
    report: "BLOCKING DETAILS"
  }, 3, {
    checkUrl: "https://gitverse.ru/acme/widget/pulls/42/checks",
    webBaseUrl: "https://gitverse.ru",
    repo: "acme/widget",
    headSha: "a".repeat(40)
  });

  assert.match(blocked, /⛔ BLOCKED/);
  assert.match(blocked, /4 findings · 3 files reviewed/);
  assert.match(blocked, /HIGH · FC-001/);
  assert.match(blocked, /Findings & fixes/);
  assert.match(blocked, /\[security-gate\.js\]\(https:\/\/gitverse\.ru\/acme\/widget\/blob\/[0-9a-f]{40}\/security-gate\.js\)/);
  assert.match(blocked, /Why:.*missing numeric value becomes zero/i);
  assert.match(blocked, /Fix:.*Validate the numeric input explicitly before applying policy/i);
  assert.match(blocked, /\.gitverse\/workflows\/ci\.yml/);
  assert.match(blocked, /\+1 more in the Reviewer check\./);
  assert.match(blocked, /Open Peerivo Reviewer check/);
  assert.doesNotMatch(blocked, /BLOCKING DETAILS/);
});

test("GitVerse pending and fail-closed cards stay minimal and keep the Checks link", () => {
  const url = "https://gitverse.ru/acme/widget/pulls/42/checks";
  assert.match(pendingBody({ checkUrl: url }), /review in progress/i);
  assert.match(pendingBody({ checkUrl: url }), /Open Peerivo Reviewer check/);
  assert.doesNotMatch(pendingBody({ checkUrl: url }), /Head:/);

  assert.match(failClosedBody({ checkUrl: url }), /REVIEW FAILED CLOSED/);
  assert.match(failClosedBody({ checkUrl: url }), /Open Peerivo Reviewer check/);
  assert.doesNotMatch(failClosedBody({ checkUrl: url }), /Head:/);
});
