import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORCHESTRATOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "orchestrator");
const CC_KNOWLEDGE_FILES = ["cc-knowledge-config.js", "cc-knowledge-error.js", "cc-knowledge-contract.js", "cc-knowledge-rag-service.js", "cc-knowledge-prompt.js"];
const NEVER_TOUCH_FILES = ["server.js", "router-service.js", "text-response-handler.js", "text-response-contract.js", "text-response-prompt.js", "cc-summary-handler.js", "structured-response-schema.js"];
const WRITE_CALL_PATTERN = /\bfs\.(writeFile(?:Sync)?|appendFile(?:Sync)?|rename(?:Sync)?|rm(?:Sync)?|unlink(?:Sync)?|mkdir(?:Sync)?)\b/;

function readOrchestratorFile(name) {
  return fs.readFileSync(path.join(ORCHESTRATOR_DIR, name), "utf8");
}

test("no active pipeline or server file imports any cc-knowledge module yet", () => {
  for (const fileName of NEVER_TOUCH_FILES) {
    const filePath = path.join(ORCHESTRATOR_DIR, fileName);
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    assert.ok(!source.includes("cc-knowledge"), `${fileName} must not reference cc-knowledge in Commit C1`);
  }
});

test("server.js does not mention a knowledge route", () => {
  const source = readOrchestratorFile("server.js");
  assert.ok(!/\/api\/v1\/cc\/knowledge/.test(source));
});

test("cc-knowledge-rag-service.js never imports the vault document loader or the re-indexer", () => {
  const source = readOrchestratorFile("cc-knowledge-rag-service.js");
  // Checks actual import statements (quoted module specifiers), not prose
  // comments that merely mention these filenames to explain why they are
  // deliberately absent.
  assert.ok(!/["']\.\/knowledge\/document-loader\.js["']/.test(source));
  assert.ok(!/["']\.\/knowledge\/rag-indexer\.js["']/.test(source));
});

test("no cc-knowledge module calls fetch directly - only the existing loopback-guarded embedding client does", () => {
  for (const fileName of CC_KNOWLEDGE_FILES) {
    const source = readOrchestratorFile(fileName);
    assert.ok(!/\bfetch\s*\(/.test(source), `${fileName} must not call fetch directly`);
  }
});

test("no cc-knowledge module performs a filesystem write, rename or delete", () => {
  for (const fileName of CC_KNOWLEDGE_FILES) {
    const source = readOrchestratorFile(fileName);
    assert.ok(!WRITE_CALL_PATTERN.test(source), `${fileName} must not contain a filesystem write call`);
  }
});

test("no cc-knowledge module defines a tool-calling or shell-execution construct", () => {
  for (const fileName of CC_KNOWLEDGE_FILES) {
    const source = readOrchestratorFile(fileName);
    assert.ok(!/child_process|spawn|exec\(/.test(source), `${fileName} must not reference process execution`);
    assert.ok(!/tool_calls|tools:\s*\[/.test(source), `${fileName} must not define tool-calling constructs`);
  }
});

test("cc-knowledge-rag-service.js calls the embedding client and search module, not a chat/answer adapter", () => {
  const source = readOrchestratorFile("cc-knowledge-rag-service.js");
  assert.ok(source.includes("embedding-client.js"));
  assert.ok(source.includes("rag-search.js"));
  assert.ok(!source.includes("provider-adapters"));
  assert.ok(!source.includes("ollama-text"));
});

// Functional coverage for "no caller-controllable threshold/top-k/snippet
// field" lives in cc-knowledge-contract.test.js (it actually submits such
// fields and asserts rejection) - a source-text grep here would also match
// this file's own explanatory comments about why those fields don't exist,
// so it is intentionally not duplicated as a static check.
