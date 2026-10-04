import test from "node:test";
import assert from "node:assert/strict";
import { collectGitLabReviewPayload, collectGitVerseReviewPayload, collectReviewPayload, shouldReviewGitLabMergeRequest, shouldReviewGitVersePullRequest, shouldReviewPullRequestAction, validateReviewerResponse } from "../src/reviewer.mjs";

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
    async tree() { return ["src/a.mjs", ".github/workflows/ci.yml", "package-lock.json"]; },
    async fileContent() { return "name: CI\non: pull_request\n"; }
  };
}


function mockGitlab({ missingPatch = false } = {}) {
  return {
    async project() {
      return { id: 9, path_with_namespace: "acme/widget", visibility: "private" };
    },
    async mergeRequest() {
      return {
        state: "opened",
        target_project_id: 9,
        source_project_id: 9,
        source_branch: "feature",
        diff_refs: { base_sha: sha("a"), head_sha: sha("b") }
      };
    },
    async mergeRequestDiffs() {
      return [
        {
          new_path: "src/a.mjs",
          old_path: "src/a.mjs",
          new_file: false,
          deleted_file: false,
          renamed_file: false,
          diff: missingPatch ? "" : "@@ -1 +1 @@\n-old\n+new"
        },
        {
          new_path: ".gitlab-ci.yml",
          old_path: ".gitlab-ci.yml",
          new_file: false,
          deleted_file: false,
          renamed_file: false,
          diff: "@@ -1 +1 @@\n-old\n+new"
        }
      ];
    },
    async tree() { return ["src/a.mjs", ".gitlab-ci.yml", "package-lock.json"]; },
    async fileContent(project, path) {
      return path === ".gitlab-ci.yml" ? "stages: [test]\n" : "export const value = 2;\n";
    }
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
  assert.ok(payload.securityFiles.some(item => item.path === "src/a.mjs"));
  assert.ok(payload.securityFiles.some(item => item.path === "package-lock.json"));
  assert.ok(payload.securityFiles.some(item => item.path === ".github/workflows/ci.yml"));
  assert.ok(payload.securityFiles.every(item => typeof item.headContent === "string"));
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

test("collector fails closed when bounded security snapshot count is exceeded", async () => {
  await assert.rejects(() => collectReviewPayload({
    github: mockGithub(), repo: "acme/widget", pullNumber: 7, token: "x",
    maxFiles: 1000, maxWorkflows: 20, maxWorkflowBytes: 10000,
    maxSecurityFiles: 1, maxSecurityFileBytes: 10000, maxSecurityBytes: 20000
  }), /MAX_SECURITY_FILES/);
});

test("reviewable GitLab merge request actions require a code-relevant event", () => {
  assert.equal(shouldReviewGitLabMergeRequest({ object_attributes: { action: "open" } }), true);
  assert.equal(shouldReviewGitLabMergeRequest({ object_attributes: { action: "reopen" } }), true);
  assert.equal(shouldReviewGitLabMergeRequest({ object_attributes: { action: "update", oldrev: sha("a") } }), true);
  assert.equal(shouldReviewGitLabMergeRequest({ object_attributes: { action: "update" }, changes: { draft: { previous: true, current: false } } }), true);
  assert.equal(shouldReviewGitLabMergeRequest({ object_attributes: { action: "approval" } }), false);
  assert.equal(shouldReviewGitLabMergeRequest({ object_attributes: { action: "update" } }), false);
});

test("GitLab collector re-fetches authoritative MR, diff, tree and CI content", async () => {
  const payload = await collectGitLabReviewPayload({
    gitlab: mockGitlab(),
    repo: "acme/widget",
    pullNumber: 7,
    maxFiles: 1000,
    maxWorkflows: 20,
    maxWorkflowBytes: 10000
  });
  assert.equal(payload.platform, "gitlab");
  assert.equal(payload.repository, "acme/widget");
  assert.equal(payload.baseSha, sha("a"));
  assert.equal(payload.headSha, sha("b"));
  assert.ok(payload.workflows.some(item => item.path === ".gitlab-ci.yml"));
  assert.ok(payload.securityFiles.some(item => item.path === "src/a.mjs"));
  assert.ok(payload.securityFiles.some(item => item.path === "package-lock.json"));
});

test("GitLab collector fails closed when a required text diff is missing", async () => {
  await assert.rejects(() => collectGitLabReviewPayload({
    gitlab: mockGitlab({ missingPatch: true }),
    repo: "acme/widget",
    pullNumber: 7,
    maxFiles: 1000,
    maxWorkflows: 20,
    maxWorkflowBytes: 10000
  }), /omitted the diff/);
});


function mockGitverse({ missingPatch = false } = {}) {
  return {
    async repository() {
      return { id: 77, full_name: "acme/widget", private: true, visibility: "private" };
    },
    async pullRequest() {
      return {
        number: 7,
        state: "open",
        base: { sha: sha("a"), repo: { full_name: "acme/widget" } },
        head: { sha: sha("b"), repo: { full_name: "acme/widget" } }
      };
    },
    async pullFiles() {
      return [
        { filename: "src/a.mjs", status: "modified", patch: missingPatch ? "" : "@@ -1 +1 @@\n-old\n+new" },
        { filename: ".gitverse/workflows/ci.yml", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }
      ];
    },
    async commit() {
      return { commit: { tree: { sha: sha("c") } } };
    },
    async tree() {
      return ["src/a.mjs", ".gitverse/workflows/ci.yml", "package-lock.json"];
    },
    async fileContent(repo, path) {
      return path.endsWith("ci.yml") ? "name: CI\non: pull_request\n" : "export const value = 2;\n";
    }
  };
}

test("GitVerse pull-request actions use explicit code-relevant actions but tolerate event payloads without action", () => {
  assert.equal(shouldReviewGitVersePullRequest({ action: "opened" }), true);
  assert.equal(shouldReviewGitVersePullRequest({ action: "synchronize" }), true);
  assert.equal(shouldReviewGitVersePullRequest({}), true);
  assert.equal(shouldReviewGitVersePullRequest({ action: "closed" }), false);
});

test("GitVerse collector re-fetches authoritative PR, files, tree and workflow content", async () => {
  const payload = await collectGitVerseReviewPayload({
    gitverse: mockGitverse(),
    repo: "acme/widget",
    pullNumber: 7,
    maxFiles: 1000,
    maxWorkflows: 20,
    maxWorkflowBytes: 10000
  });
  assert.equal(payload.platform, "gitverse");
  assert.equal(payload.repository, "acme/widget");
  assert.equal(payload.baseSha, sha("a"));
  assert.equal(payload.headSha, sha("b"));
  assert.ok(payload.workflows.some(item => item.path === ".gitverse/workflows/ci.yml"));
  assert.ok(payload.securityFiles.some(item => item.path === "src/a.mjs"));
  assert.ok(payload.securityFiles.some(item => item.path === "package-lock.json"));
});

test("GitVerse collector fails closed when a required text patch is missing", async () => {
  await assert.rejects(() => collectGitVerseReviewPayload({
    gitverse: mockGitverse({ missingPatch: true }),
    repo: "acme/widget",
    pullNumber: 7,
    maxFiles: 1000,
    maxWorkflows: 20,
    maxWorkflowBytes: 10000
  }), /omitted the patch/);
});
