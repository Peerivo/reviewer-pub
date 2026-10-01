import test from "node:test";
import assert from "node:assert/strict";
import { GitLabClient } from "../src/gitlab.mjs";
import { gitLabHeadPipelineId } from "../src/gitlab-app.mjs";

test("GitLab status targets the exact MR pipeline when provided", async () => {
  let requestUrl = "";
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.com",
    token: "token",
    authMode: "bearer",
    fetchImpl: async (input) => {
      requestUrl = String(input);
      return Response.json({ id: 1, status: "success" }, { status: 201 });
    }
  });

  await client.setCommitStatus(7, "a".repeat(40), {
    state: "success",
    description: "Passed — 0 findings",
    ref: "test/peerivo-reviewer",
    targetUrl: "https://gitlab.example.com/acme/test/-/merge_requests/1",
    pipelineId: 12345
  });

  const url = new URL(requestUrl);
  assert.equal(url.searchParams.get("pipeline_id"), "12345");
  assert.equal(url.searchParams.get("name"), "Peerivo Reviewer");
  assert.equal(url.searchParams.get("ref"), "test/peerivo-reviewer");
});

test("MR head pipeline is selected only when project and SHA match", () => {
  const sha = "b".repeat(40);
  const mr = {
    head_pipeline: {
      id: 12345,
      project_id: 7,
      sha
    }
  };

  assert.equal(gitLabHeadPipelineId(mr, 7, sha), 12345);
  assert.equal(gitLabHeadPipelineId(mr, 8, sha), null);
  assert.equal(gitLabHeadPipelineId(mr, 7, "c".repeat(40)), null);
  assert.equal(gitLabHeadPipelineId({ head_pipeline: null }, 7, sha), null);
});

test("GitLab status rejects an invalid pipeline id", async () => {
  const client = new GitLabClient({
    baseUrl: "https://gitlab.example.com",
    token: "token",
    fetchImpl: async () => {
      throw new Error("request should not be sent");
    }
  });

  await assert.rejects(
    client.setCommitStatus(7, "a".repeat(40), {
      state: "success",
      description: "Passed",
      pipelineId: 0
    }),
    /invalid pipeline id/
  );
});
