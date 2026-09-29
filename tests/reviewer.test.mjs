import test from "node:test";
import assert from "node:assert/strict";
import { collectReviewPayload, shouldReviewPullRequestAction, validateReviewerResponse } from "../src/reviewer.mjs";

const sha = char => char.repeat(40);

function mockGithub({ missingPatch = false } = {}) {
  return {
    async pullRequest() {
      return {
        base: { sha: sha("a"), repo: { full_name: "acme/widget", visibility: "private", private: true } },
        head: { sha: sha("b") }
      };
    },
    async pullFiles() {
      return [
        { filename: "src/a.mjs", status: "modified", patch: missingPatch ? undefined : "@@ -1 +1 @@\n-old\n+new" },
        { filename: ".github/workflows/ci.yml", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }
      ];
    },
    async tree() { return ["src/a.mjs", ".github/workflows/ci.yml"]; },
    async fileContent() { return "name: CI\non: pull_request\n"; }
  };
}

test("reviewable PR actions are explicit", () => {
  for (const action of ["opened", "reopened", "synchronize", "ready_for_review"]) assert.equal(shouldReviewPullRequestAction(action), true);
  for (const action of ["closed", "labeled", "edited", "converted_to_draft"]) assert.equal(shouldReviewPullRequestAction(action), false);
});

test("collector uses authoritative GitHub data and includes workflow content", async () => {
  const payload = await collectReviewPayload({
    github: mockGithub(), repo: "acme/widget", pullNumber: 7, token: "x",
    maxFiles: 1000, maxWorkflows: 20, maxWorkflowBytes: 10000
  });
  assert.equal(payload.repository, "acme/widget");
  assert.equal(payload.pullRequest, 7);
  assert.equal(payload.baseSha, sha("a"));
  assert.equal(payload.headSha, sha("b"));
  assert.equal(payload.workflows.length, 1);
});

test("collector fails closed when GitHub omits a text patch", async () => {
  await assert.rejects(() => collectReviewPayload({
    github: mockGithub({ missingPatch: true }), repo: "acme/widget", pullNumber: 7, token: "x",
    maxFiles: 1000, maxWorkflows: 20, maxWorkflowBytes: 10000
  }), /omitted the patch/);
});

test("Reviewer response schema rejects fail-open ambiguity", () => {
  assert.throws(() => validateReviewerResponse({ schemaVersion: 1, reviewId: "r", findings: [], report: "x" }), /failed/);
  assert.equal(validateReviewerResponse({ schemaVersion: 1, reviewId: "r", failed: false, findings: [], report: "ok" }).failed, false);
});
