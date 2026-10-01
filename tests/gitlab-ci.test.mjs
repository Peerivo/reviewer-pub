import test from "node:test";
import assert from "node:assert/strict";
import { createGitLabCiBridge, formatGitLabCiConsoleResult, validateGitLabCiRequest } from "../src/gitlab-ci.mjs";

const sha = "b".repeat(40);
const baseSha = "a".repeat(40);

function config() {
  return {
    gitlabBaseUrl: "https://gitlab.example.com",
    reviewerApiUrl: "https://reviewer.example.com",
    reviewerApiToken: "service-token",
    reviewTimeoutMs: 5_000,
    maxFiles: 100,
    maxWorkflows: 20,
    maxWorkflowBytes: 1024 * 1024,
    maxSecurityFiles: 20,
    maxSecurityFileBytes: 256 * 1024,
    maxSecurityBytes: 1024 * 1024
  };
}

function gitlabStub() {
  return {
    async project(id) {
      assert.ok(id === 7 || id === "triombus/test");
      return {
        id: 7,
        path_with_namespace: "triombus/test",
        visibility: "public",
        web_url: "https://gitlab.example.com/triombus/test"
      };
    },
    async mergeRequest(repo, iid) {
      assert.equal(repo, "triombus/test");
      assert.equal(iid, 1);
      return {
        state: "opened",
        target_project_id: 7,
        source_project_id: 7,
        diff_refs: { base_sha: baseSha, head_sha: sha },
        head_pipeline: { id: 99, project_id: 7, sha }
      };
    },
    async mergeRequestDiffs() {
      return [{
        old_path: ".gitlab-ci.yml",
        new_path: ".gitlab-ci.yml",
        new_file: false,
        deleted_file: false,
        renamed_file: false,
        diff: "@@ -1 +1 @@\n-stages: [test]\n+stages: [test, external]\n"
      }];
    },
    async tree() {
      return [".gitlab-ci.yml", "README.md"];
    },
    async fileContent(projectId, path, ref) {
      assert.equal(projectId, 7);
      if (path === ".gitlab-ci.yml") return "stages: [test, external]\n";
      return ref === sha ? "# current\n" : "# base\n";
    }
  };
}

function selfService() {
  return {
    store: {
      getProject(id) {
        assert.equal(id, 7);
        return {
          projectId: 7,
          installationId: "installation-1",
          pathWithNamespace: "triombus/test"
        };
      }
    },
    async gitlabForInstallation(id) {
      assert.equal(id, "installation-1");
      return gitlabStub();
    }
  };
}

test("GitLab Free CI bridge validates job identity and returns Reviewer result", async () => {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), options });

    if (url.origin === "https://gitlab.example.com" && url.pathname === "/api/v4/job") {
      assert.equal(options.headers["job-token"], "ci-job-token");
      return Response.json({
        id: 123,
        project: { ci_job_token_scope_enabled: false },
        pipeline: { id: 99, project_id: 7 },
        commit: { id: sha }
      });
    }

    if (url.origin === "https://reviewer.example.com" && url.pathname === "/v1/reviews") {
      assert.equal(options.headers["x-peerivo-gitlab-project-id"], "7");
      assert.equal(options.headers["x-peerivo-gitlab-delivery-id"], "ci-123");
      return Response.json({
        schemaVersion: 1,
        reviewId: "review-1",
        failed: false,
        findings: [],
        report: "PASS"
      });
    }

    throw new Error(`unexpected request: ${options.method || "GET"} ${url}`);
  };

  const bridge = createGitLabCiBridge({
    config: config(),
    selfService: selfService(),
    fetchImpl
  });

  const result = await bridge.review({
    jobToken: "ci-job-token",
    request: {
      projectId: 7,
      mergeRequestIid: 1,
      pipelineId: 99,
      jobId: 123,
      sha
    }
  });

  assert.equal(result.failed, false);
  assert.equal(result.reviewId, "review-1");
  assert.equal(result.pipelineId, 99);
  assert.equal(result.repository, "triombus/test");
  assert.equal(result.projectUrl, "https://gitlab.example.com/triombus/test");
  assert.equal(result.filesReviewed, 1);
  assert.equal(calls.length, 2);
});

test("GitLab Free CI bridge fails closed when job identity mismatches", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v4/job") {
      return Response.json({
        id: 999,
        project: { ci_job_token_scope_enabled: false },
        pipeline: { id: 99, project_id: 7 },
        commit: { id: sha }
      });
    }
    throw new Error("reviewer API must not be reached");
  };

  const bridge = createGitLabCiBridge({
    config: config(),
    selfService: selfService(),
    fetchImpl
  });

  await assert.rejects(
    bridge.review({
      jobToken: "ci-job-token",
      request: {
        projectId: 7,
        mergeRequestIid: 1,
        pipelineId: 99,
        jobId: 123,
        sha
      }
    }),
    /job identity mismatch/
  );
});

test("GitLab CI request validation rejects malformed identifiers", () => {
  assert.throws(() => validateGitLabCiRequest({
    projectId: 0,
    mergeRequestIid: 1,
    pipelineId: 2,
    jobId: 3,
    sha
  }), /project id/);

  assert.throws(() => validateGitLabCiRequest({
    projectId: 7,
    mergeRequestIid: 1,
    pipelineId: 2,
    jobId: 3,
    sha: "abc"
  }), /commit SHA/);
});


test("GitLab console PASS report stays compact and strips Markdown details", () => {
  const output = formatGitLabCiConsoleResult({
    failed: false,
    findings: [],
    filesReviewed: 2,
    repository: "triombus/test",
    mergeRequestIid: 1,
    reviewId: "review-pass",
    report: "### Result\n<details>huge markdown</details>"
  });

  assert.match(output, /Peerivo Reviewer — PASS/);
  assert.match(output, /Findings: 0/);
  assert.match(output, /Files reviewed: 2/);
  assert.match(output, /Merge request: triombus\/test !1/);
  assert.match(output, /\u001b\[32m✓\u001b\[0m CI \/ supply chain/);
  assert.match(output, /\u001b\[32m✓\u001b\[0m Secrets/);
  assert.match(output, /Review ID: review-pass/);
  assert.doesNotMatch(output, /<details>/);
  assert.doesNotMatch(output, /### Result/);
});

test("GitLab console BLOCKED report prints concise findings", () => {
  const output = formatGitLabCiConsoleResult({
    failed: true,
    filesReviewed: 3,
    repository: "triombus/test",
    projectUrl: "https://gitlab.example.com/triombus/test",
    sha,
    mergeRequestIid: 1,
    reviewId: "review-blocked",
    findings: [
      {
        id: "CI-004",
        severity: "high",
        title: "Third-party Action is not pinned",
        path: ".gitlab-ci.yml"
      },
      {
        id: "SUPPLY-001",
        severity: "high",
        message: "Remote content is piped to a shell",
        path: ".gitlab-ci.yml"
      }
    ]
  });

  assert.match(output, /Peerivo Reviewer — BLOCKED/);
  assert.match(output, /Findings: 2/);
  assert.match(output, /\u001b\[31m✗\u001b\[0m CI \/ supply chain \(2 findings\)/);
  assert.match(output, /\u001b\[32m✓\u001b\[0m Secrets/);
  assert.match(output, /\u001b\[31m\[HIGH\] CI-004\u001b\[0m Third-party Action is not pinned/);
  assert.match(output, /File: \.gitlab-ci\.yml/);
  assert.match(output, /Open: https:\/\/gitlab\.example\.com\/triombus\/test\/-\/blob\/[0-9a-f]{40}\/\.gitlab-ci\.yml/);
  assert.match(output, /Fix:  Pin the third-party Action to a full immutable commit SHA\./);
  assert.match(output, /\u001b\[31m\[HIGH\] SUPPLY-001\u001b\[0m Remote content is piped to a shell/);
  assert.match(output, /Fix:  Download the artifact first, verify its checksum\/signature, then execute the verified local file\./);
});
