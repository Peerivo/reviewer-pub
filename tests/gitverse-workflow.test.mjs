import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { GITVERSE_REVIEWER_WORKFLOW } from "../src/gitverse-workflow.mjs";

// Extract what the runner actually executes, not a separately maintained script.
function generatedScript() {
  const [, run] = GITVERSE_REVIEWER_WORKFLOW.split("        run: |\n");
  assert.ok(run, "generated workflow must contain its shell step");
  return run.split("\n").map(line => {
    if (!line) return "";
    assert.ok(line.startsWith("          "), "invalid YAML run indentation");
    return line.slice(10);
  }).join("\n");
}

const curlStub = `#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const args = process.argv.slice(2);
const report = args[args.indexOf("--output") + 1];
assert.deepEqual(args, [
  "--disable", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2",
  "--connect-timeout", "15", "--max-time", "180", "--request", "POST",
  "--header", "Authorization: Bearer " + process.env.PEERIVO_GATE_TOKEN,
  "--header", "Content-Type: application/json",
  "--data", JSON.stringify({repository:process.env.PEERIVO_REPOSITORY,
    pullNumber:Number(process.env.PEERIVO_PULL_REQUEST),headSha:process.env.PEERIVO_HEAD_SHA}),
  "--output", report, "--write-out", "%{http_code}", process.env.PEERIVO_GATE_URL
], "curl arguments must remain intact after JavaScript -> YAML -> Bash expansion");
assert.ok(report && fs.existsSync(report), "report is created before the request");
assert.equal(fs.statSync(report).mode & 0o777, 0o600);
fs.writeFileSync(process.env.MOCK_TRACE, JSON.stringify({report}));
if (process.env.MOCK_REMOVE_REPORT === "1") fs.unlinkSync(report);
else fs.writeFileSync(report, process.env.MOCK_BODY);
process.stdout.write(process.env.MOCK_HTTP);
process.exitCode = Number(process.env.MOCK_EXIT);
`;

function execute({ http = "200", body = "Peerivo Reviewer — PASSED\n", curlExit = 0, removeReport = false, missingToken = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "peerivo-gitverse-shell-"));
  const trace = join(directory, "trace.json");
  const token = "test-only-token-'\" $() ; *";
  try {
    writeFileSync(join(directory, "curl"), curlStub, { mode: 0o700 });
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", generatedScript()], {
      encoding: "utf8", timeout: 10000,
      env: {
        ...process.env, PATH: directory + ":" + process.env.PATH,
        TMPDIR: directory, BASH_ENV: "", ENV: "",
        PEERIVO_GATE_URL: "https://pub.reviewer.peerivo.net/v1/ci/gitverse/review",
        PEERIVO_GATE_TOKEN: missingToken ? "" : token,
        PEERIVO_REPOSITORY: "acme/widget", PEERIVO_PULL_REQUEST: "42", PEERIVO_HEAD_SHA: "a".repeat(40),
        MOCK_TRACE: trace, MOCK_HTTP: http, MOCK_BODY: body, MOCK_EXIT: String(curlExit),
        MOCK_REMOVE_REPORT: removeReport ? "1" : "0"
      }
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.doesNotMatch(result.stderr, /AssertionError/, result.stderr);
    assert.ok(!(result.stdout + result.stderr).includes(token), "token must not enter CI logs");
    if (existsSync(trace)) {
      const { report } = JSON.parse(readFileSync(trace, "utf8"));
      assert.equal(existsSync(report), false, "temporary report must be removed on every exit");
    } else {
      assert.ok(missingToken, "curl must be invoked with validated arguments");
    }
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("generated GitVerse shell preserves headers, JSON and HTTPS URL and accepts a complete 200 response", () => {
  const result = execute();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASSED/);
});

test("generated GitVerse shell returns 1 for blocking findings, not infrastructure error", () => {
  const result = execute({ http: "422", body: "Peerivo Reviewer — BLOCKED\nCI-004: pin the action\n" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CI-004/);
});

for (const http of ["000", "302", "401", "403", "409", "429", "500", "503", "200200"]) {
  test(`generated GitVerse shell fails closed on HTTP ${http}`, () => {
    const result = execute({ http, body: "MISLEADING PASS" });
    assert.equal(result.status, 2);
    assert.match(result.stdout, /ERROR/);
    assert.doesNotMatch(result.stdout, /MISLEADING PASS/);
  });
}

for (const curlExit of [1, 3, 6, 28, 35, 60]) {
  test(`generated GitVerse shell rejects transport exit ${curlExit} even after HTTP 200`, () => {
    const result = execute({ curlExit, body: "PARTIAL PASS" });
    assert.equal(result.status, 2);
    assert.match(result.stdout, new RegExp(`curl exit ${curlExit}`));
    assert.doesNotMatch(result.stdout, /PARTIAL PASS/);
  });
}

for (const http of ["200", "422"]) {
  test(`generated GitVerse shell rejects an empty report with HTTP ${http}`, () => {
    const result = execute({ http, body: "" });
    assert.equal(result.status, 2);
    assert.match(result.stdout, /response report is empty/);
  });
}

test("generated GitVerse shell handles a missing report without a misleading cat failure", () => {
  const result = execute({ removeReport: true });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /response report is empty/);
  assert.doesNotMatch(result.stderr, /No such file/);
});

test("generated GitVerse shell stops before curl when installation secret is missing", () => {
  const result = execute({ missingToken: true });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /installation secret is missing/);
});
