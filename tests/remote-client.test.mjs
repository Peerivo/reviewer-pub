import test from "node:test";
import assert from "node:assert/strict";
import { formatRemoteConsoleResult } from "../clients/remote-reviewer.mjs";

test("GitVerse hard-gate console shows actionable finding details", () => {
  const output = formatRemoteConsoleResult({
    schemaVersion: 1,
    failed: true,
    reviewId: "review-gv-1",
    findings: [{
      id: "SUPPLY-001",
      severity: "high",
      title: "Remote content piped directly to a shell",
      message: "The workflow downloads remote content and executes it immediately.",
      remediation: "Download the artifact, verify integrity, then execute the verified local file.",
      path: ".gitverse/workflows/ci.yml"
    }],
    report: "RAW MARKDOWN THAT MUST NOT BE PRINTED"
  }, {
    platform: "gitverse",
    repository: "olegka85/test",
    headSha: "a".repeat(40),
    changedFiles: 2
  });

  assert.match(output, /Peerivo Reviewer — BLOCKED/);
  assert.match(output, /Findings: 1/);
  assert.match(output, /Files reviewed: 2/);
  assert.match(output, /File: \.gitverse\/workflows\/ci\.yml/);
  assert.match(output, /Open: https:\/\/gitverse\.ru\/olegka85\/test\/blob\/[0-9a-f]{40}\/\.gitverse\/workflows\/ci\.yml/);
  assert.match(output, /Why:.*downloads remote content/i);
  assert.match(output, /Fix:.*verify integrity/i);
  assert.doesNotMatch(output, /RAW MARKDOWN/);
});

test("GitVerse hard-gate PASS console stays compact", () => {
  const output = formatRemoteConsoleResult({
    schemaVersion: 1,
    failed: false,
    reviewId: "review-gv-pass",
    findings: [],
    report: "RAW MARKDOWN"
  }, {
    platform: "gitverse",
    repository: "olegka85/test",
    headSha: "b".repeat(40),
    changedFiles: 3
  });

  assert.match(output, /Peerivo Reviewer — PASS/);
  assert.match(output, /Findings: 0/);
  assert.match(output, /Files reviewed: 3/);
  assert.doesNotMatch(output, /RAW MARKDOWN/);
});
