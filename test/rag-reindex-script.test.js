import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "rag-reindex.js");

function runScript(envOverrides) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: REPO_ROOT,
    env: { ...process.env, AI_ROUTER_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "rag-script-")), ...envOverrides },
    encoding: "utf8"
  });
}

test("exits non-zero and reports a structured error when the vault root is not configured", () => {
  const result = runScript({ AI_ROUTER_VAULT_ROOT: "", AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "bge-m3" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VAULT_ROOT_NOT_CONFIGURED/);
});

test("exits non-zero and reports a structured error when the embedding model is not configured", () => {
  const result = runScript({ AI_ROUTER_VAULT_ROOT: REPO_ROOT, AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EMBEDDING_MODEL_NOT_AVAILABLE/);
});
