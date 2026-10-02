import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const component = fs.readFileSync(new URL("../gitlab-catalog/templates/reviewer.yml", import.meta.url), "utf8");
const match = component.match(/  script:\n    - \|\n([\s\S]*?)\n  rules:/);
assert.ok(match, "Component contains a bounded shell script");
const script = match[1].split("\n").map(line => line.replace(/^      /, "")).join("\n");

function runBridge({ status = "200", body = "Peerivo Reviewer — PASS\n", curlExit = "0" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peerivo-catalog-test-"));
  try {
    fs.writeFileSync(path.join(dir, "curl"), `#!/bin/sh
set -eu
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$FAKE_BODY" > "$output"
printf '%s' "$FAKE_STATUS"
exit "$FAKE_EXIT"
`, { mode: 0o700 });
    return spawnSync("sh", ["-c", script.replaceAll("/tmp/peerivo-review", path.join(dir, "report"))], {
      encoding: "utf8", timeout: 5000, cwd: dir,
      env: {
        PATH: `${dir}:${process.env.PATH}`, CI_PROJECT_ID: "123", CI_MERGE_REQUEST_IID: "1",
        CI_PIPELINE_ID: "456", CI_JOB_ID: "789", CI_COMMIT_SHA: "a".repeat(40), CI_JOB_TOKEN: "test-only",
        FAKE_STATUS: status, FAKE_BODY: body, FAKE_EXIT: curlExit
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("catalog component isolates inherited project scripts, caches and artifacts", () => {
  assert.match(component, /inherit:\n    default: false/);
  for (const field of ["before_script", "after_script", "cache", "dependencies"]) {
    assert.match(component, new RegExp(`^  ${field}: \\[\\]$`, "m"));
  }
  assert.match(component, /GIT_STRATEGY: "none"/);
  assert.match(component, /GIT_SUBMODULE_STRATEGY: "none"/);
  assert.match(component, /allow_failure: false/);
  assert.match(component, /--connect-timeout 10 --max-time 180/);
  assert.match(component, /\$CI_PIPELINE_SOURCE == "merge_request_event"/);
});

test("catalog bridge accepts a completed HTTP 200 report", () => {
  const result = runBridge();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Peerivo Reviewer — PASS/);
});

test("catalog bridge prints blocking findings before failing", () => {
  const result = runBridge({ status: "422", body: "Peerivo Reviewer — BLOCKED\nSUPPLY-001: .gitlab-ci.yml\n" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /SUPPLY-001: .gitlab-ci.yml/);
});

for (const status of ["202", "204", "302", "401", "403", "429", "500", "503"]) {
  test(`catalog bridge fails closed for HTTP ${status}`, () => {
    assert.equal(runBridge({ status }).status, 1);
  });
}

test("catalog bridge rejects an empty HTTP 200 response", () => {
  assert.equal(runBridge({ body: "" }).status, 1);
});

test("catalog bridge fails closed on a curl network error", () => {
  assert.equal(runBridge({ status: "000", body: "", curlExit: "28" }).status, 28);
});
