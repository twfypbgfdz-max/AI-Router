import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Ambient secrets (e.g. a real AI_ROUTER_CC_TOKEN configured on a developer
// machine for local Command-Center integration) must never leak into the
// test process: tests that need a token build their own isolated env object
// and must never rely on inheriting one from whatever shell happens to run
// `npm test`. Matches only the closed AI_ROUTER_*_TOKEN secret pattern (not
// the plural *_TOKENS pricing config vars like
// AI_ROUTER_OPENAI_INPUT_USD_PER_MILLION_TOKENS, which are legitimate
// non-secret config and are fine to inherit).
export const AI_ROUTER_TOKEN_ENV_PATTERN = /^AI_ROUTER_.*_TOKEN$/;

export function sanitizeTestEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !AI_ROUTER_TOKEN_ENV_PATTERN.test(key))
  );
}

// Known limitation, not a bug: this sanitization only takes effect when
// tests run through `npm test` / `node scripts/run-tests.js`, i.e. through
// runTests() below, which is the only caller of sanitizeTestEnv(). A direct
// invocation such as `node --test test/cc-status.test.js` bypasses this file
// entirely and inherits the ambient environment unfiltered - tests that
// depend on AI_ROUTER_*_TOKEN being absent (e.g. cc-status.test.js) can fail
// again if such a variable happens to be set in that shell.

function runTests() {
  const temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-router-tests-"));
  let exitCode = 1;
  try {
    const result = spawnSync(process.execPath, ["--test"], {
      stdio: "inherit",
      windowsHide: true,
      env: { ...sanitizeTestEnv(process.env), AI_ROUTER_DATA_DIR: temporaryDataDir }
    });
    exitCode = Number.isInteger(result.status) ? result.status : 1;
    if (result.error) console.error("Test runner could not start the Node.js test process.");
  } finally {
    fs.rmSync(temporaryDataDir, { recursive: true, force: true });
  }
  process.exitCode = exitCode;
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) runTests();
