import test from "node:test";
import assert from "node:assert/strict";
import { buildConversationCard, upsertConversationCard } from "../src/app.mjs";

test("conversation card updates the existing Peerivo Reviewer bot comment", async () => {
  const calls = [];
  const github = {
    async listIssueComments() {
      return [{
        id: 77,
        body: "<!-- peerivo-reviewer-card -->\nold",
        user: { type: "Bot", login: "peerivo-reviewer[bot]" },
        performed_via_github_app: { id: 5146938 }
      }];
    },
    async updateIssueComment(repo, id, token, body) {
      calls.push({ kind: "update", repo, id, token, body });
      return { id, body };
    },
    async createIssueComment() {
      throw new Error("should not create a duplicate card");
    }
  };

  const result = await upsertConversationCard({
    github,
    repo: "acme/widget",
    pullNumber: 42,
    token: "installation-token",
    appId: "5146938",
    body: "> [!TIP]\n> **✅ PASS**"
  });

  assert.equal(result.id, 77);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "update");
  assert.match(calls[0].body, /^<!-- peerivo-reviewer-card -->/);
  assert.match(calls[0].body, /✅ PASS/);
});

test("conversation card ignores a spoofed user marker and creates the bot card", async () => {
  const calls = [];
  const github = {
    async listIssueComments() {
      return [{
        id: 12,
        body: "<!-- peerivo-reviewer-card -->\nspoof",
        user: { type: "User", login: "attacker" },
        performed_via_github_app: null
      }];
    },
    async updateIssueComment() {
      throw new Error("must not edit another user's marker");
    },
    async createIssueComment(repo, issueNumber, token, body) {
      calls.push({ kind: "create", repo, issueNumber, token, body });
      return { id: 99, body };
    }
  };

  const result = await upsertConversationCard({
    github,
    repo: "acme/widget",
    pullNumber: 42,
    token: "installation-token",
    appId: 5146938,
    body: "> [!CAUTION]\n> **⛔ BLOCKED**"
  });

  assert.equal(result.id, 99);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "create");
  assert.match(calls[0].body, /⛔ BLOCKED/);
});


test("compact PASS card keeps details in the Reviewer check", () => {
  const body = buildConversationCard({
    state: "passed",
    findings: 0,
    files: 2,
    checkUrl: "https://github.com/acme/widget/runs/123"
  });
  assert.match(body, /✅ PASS/);
  assert.match(body, /0 findings · 2 files reviewed/);
  assert.match(body, /Open Peerivo Reviewer check/);
  assert.doesNotMatch(body, /Coverage/);
  assert.doesNotMatch(body, /Technical details/);
});

test("compact blocking card links to the exact Reviewer check", () => {
  const body = buildConversationCard({
    state: "blocked",
    findings: 2,
    files: 3,
    checkUrl: "https://github.com/acme/widget/runs/456"
  });
  assert.match(body, /⛔ BLOCKED/);
  assert.match(body, /2 findings · 3 files reviewed/);
  assert.match(body, /https:\/\/github\.com\/acme\/widget\/runs\/456/);
});

test("running card stays minimal", () => {
  const body = buildConversationCard({
    state: "running",
    checkUrl: "https://github.com/acme/widget/runs/789"
  });
  assert.match(body, /Review in progress/);
  assert.match(body, /Open Peerivo Reviewer check/);
  assert.doesNotMatch(body, /report will update/i);
});
