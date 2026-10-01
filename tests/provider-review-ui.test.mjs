import test from "node:test";
import assert from "node:assert/strict";
import { gitLabStatusDescription } from "../src/gitlab-app.mjs";
import { pendingBody, resultBody, failClosedBody } from "../src/gitverse-app.mjs";

test("GitLab status stays compact and Reviewer-branded", () => {
  assert.equal(gitLabStatusDescription({ state: "pending" }), "Review in progress");
  assert.equal(gitLabStatusDescription({ state: "passed", findings: 0 }), "Passed — 0 findings");
  assert.equal(gitLabStatusDescription({ state: "blocked", findings: 2 }), "Blocked — 2 findings");
  assert.equal(gitLabStatusDescription({ state: "failed_closed" }), "Failed closed");
});

test("GitVerse card mirrors compact GitHub presentation", () => {
  const pass = resultBody({
    failed: false,
    findings: [],
    report: "FULL DETAILS"
  }, 2);

  assert.match(pass, /✅ PASS/);
  assert.match(pass, /0 findings · 2 files reviewed/);
  assert.match(pass, /<details>/);
  assert.match(pass, /View Peerivo Reviewer details/);
  assert.match(pass, /FULL DETAILS/);

  const blocked = resultBody({
    failed: true,
    findings: [{ id: "CI-004" }, { id: "CI-005" }],
    report: "BLOCKING DETAILS"
  }, 3);
  assert.match(blocked, /⛔ BLOCKED/);
  assert.match(blocked, /2 findings · 3 files reviewed/);
});

test("GitVerse pending and fail-closed cards stay minimal", () => {
  assert.match(pendingBody(), /Review in progress/);
  assert.doesNotMatch(pendingBody(), /Head:/);
  assert.match(failClosedBody(), /REVIEW FAILED CLOSED/);
  assert.doesNotMatch(failClosedBody(), /Head:/);
});
