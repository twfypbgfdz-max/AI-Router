import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeTestEnv, AI_ROUTER_TOKEN_ENV_PATTERN } from "../scripts/run-tests.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("sanitizeTestEnv strips only the closed AI_ROUTER_*_TOKEN secret pattern", () => {
  const sanitized = sanitizeTestEnv({
    AI_ROUTER_CC_TOKEN: "some-secret-value",
    AI_ROUTER_INTERNAL_TOKEN: "another-secret-value",
    // Plural *_TOKENS pricing config is not a secret and must survive.
    AI_ROUTER_OPENAI_INPUT_USD_PER_MILLION_TOKENS: "1",
    AI_ROUTER_OPENAI_OUTPUT_USD_PER_MILLION_TOKENS: "2",
    AI_ROUTER_DATA_DIR: "/tmp/whatever",
    PATH: "/usr/bin"
  });
  assert.equal("AI_ROUTER_CC_TOKEN" in sanitized, false);
  assert.equal("AI_ROUTER_INTERNAL_TOKEN" in sanitized, false);
  assert.equal(sanitized.AI_ROUTER_OPENAI_INPUT_USD_PER_MILLION_TOKENS, "1");
  assert.equal(sanitized.AI_ROUTER_OPENAI_OUTPUT_USD_PER_MILLION_TOKENS, "2");
  assert.equal(sanitized.AI_ROUTER_DATA_DIR, "/tmp/whatever");
  assert.equal(sanitized.PATH, "/usr/bin");
});

test("AI_ROUTER_TOKEN_ENV_PATTERN matches only the closed secret-token shape", () => {
  assert.equal(AI_ROUTER_TOKEN_ENV_PATTERN.test("AI_ROUTER_CC_TOKEN"), true);
  assert.equal(AI_ROUTER_TOKEN_ENV_PATTERN.test("AI_ROUTER_INTERNAL_TOKEN"), true);
  assert.equal(AI_ROUTER_TOKEN_ENV_PATTERN.test("AI_ROUTER_OPENAI_INPUT_USD_PER_MILLION_TOKENS"), false);
  assert.equal(AI_ROUTER_TOKEN_ENV_PATTERN.test("AI_ROUTER_DATA_DIR"), false);
});

// Regression test for the original symptom: a real AI_ROUTER_CC_TOKEN
// configured ambiently in the parent process (e.g. a developer's Windows
// user environment for local Command-Center integration) must never make
// the "no CC token configured" router test observe a configured token.
// Runs the actual cc-status suite in a child process through the same
// sanitization scripts/run-tests.js applies, with a foreign token injected
// into the parent-simulating env to prove it does not leak through.
test("an ambient AI_ROUTER_CC_TOKEN in the parent environment does not leak into the router test process", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-router-run-tests-script-"));
  try {
    const pollutedParentEnv = {
      ...process.env,
      AI_ROUTER_CC_TOKEN: "ambient-foreign-cc-token-should-never-leak-0123456789"
    };
    const result = spawnSync(process.execPath, ["--test", "test/cc-status.test.js"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      encoding: "utf8",
      windowsHide: true,
      env: { ...sanitizeTestEnv(pollutedParentEnv), AI_ROUTER_DATA_DIR: dataDir }
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
