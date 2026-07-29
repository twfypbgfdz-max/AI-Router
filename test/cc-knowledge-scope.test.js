import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORCHESTRATOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "orchestrator");
const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "api", "v1", "cc");
const CC_KNOWLEDGE_FILES = [
  "cc-knowledge-config.js", "cc-knowledge-error.js", "cc-knowledge-contract.js",
  "cc-knowledge-rag-service.js", "cc-knowledge-prompt.js", "cc-knowledge-response.js", "cc-knowledge-handler.js"
];
const WRITE_CALL_PATTERN = /\bfs\.(writeFile(?:Sync)?|appendFile(?:Sync)?|rename(?:Sync)?|rm(?:Sync)?|unlink(?:Sync)?|mkdir(?:Sync)?)\b/;

function readOrchestratorFile(name) {
  return fs.readFileSync(path.join(ORCHESTRATOR_DIR, name), "utf8");
}

// Commit C2b activates exactly one new route. These tests replace the
// Commit C1 "no route exists at all" checks with "exactly this one route
// exists, wired only where expected, and nothing beyond it".

test("server.js wires exactly one knowledge route: POST /api/v1/cc/knowledge", () => {
  const source = readOrchestratorFile("server.js");
  const matches = source.match(/\/api\/v1\/cc\/knowledge/g) || [];
  assert.equal(matches.length, 1, "the route path must appear exactly once in server.js");
  assert.ok(source.includes("handleCcKnowledgeRequest"));
});

test("no GET, re-index, allowlist or model-pull route exists anywhere in the codebase", () => {
  const source = readOrchestratorFile("server.js");
  assert.ok(!/\/api\/v1\/cc\/knowledge\/reindex/i.test(source));
  assert.ok(!/\/api\/v1\/cc\/knowledge\/allowlist/i.test(source));
  assert.ok(!/\/api\/v1\/cc\/knowledge\/pull/i.test(source));
  assert.ok(!/\/api\/v1\/cc\/knowledge\/model/i.test(source));
});

test("the API route wrapper only forwards to the handler, no extra logic", () => {
  const source = fs.readFileSync(path.join(API_DIR, "knowledge.js"), "utf8");
  assert.ok(source.includes("handleCcKnowledgeRequest"));
  assert.ok(!/fs\.|child_process|fetch\(/.test(source));
});

test("cc-knowledge-rag-service.js never imports the vault document loader or the re-indexer", () => {
  const source = readOrchestratorFile("cc-knowledge-rag-service.js");
  // Checks actual import statements (quoted module specifiers), not prose
  // comments that merely mention these filenames to explain why they are
  // deliberately absent.
  assert.ok(!/["']\.\/knowledge\/document-loader\.js["']/.test(source));
  assert.ok(!/["']\.\/knowledge\/rag-indexer\.js["']/.test(source));
});

test("cc-knowledge-handler.js never imports the vault document loader or the re-indexer", () => {
  const source = readOrchestratorFile("cc-knowledge-handler.js");
  assert.ok(!/["']\.\/knowledge\/document-loader\.js["']/.test(source));
  assert.ok(!/["']\.\/knowledge\/rag-indexer\.js["']/.test(source));
  assert.ok(!/["']\.\.?\/knowledge\/rag-config\.js["'].*RAG_ALLOWLIST_FILE/.test(source));
});

test("no cc-knowledge module calls fetch directly - only the existing loopback-guarded embedding/Ollama clients do", () => {
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

test("no cc-knowledge module references process execution", () => {
  for (const fileName of CC_KNOWLEDGE_FILES) {
    const source = readOrchestratorFile(fileName);
    assert.ok(!/child_process|\bspawn\(|\bexec\(/.test(source), `${fileName} must not reference process execution`);
  }
});

test("no cc-knowledge module defines an outgoing tool-calling structure", () => {
  for (const fileName of CC_KNOWLEDGE_FILES) {
    const source = readOrchestratorFile(fileName);
    // cc-knowledge-handler.js legitimately contains the literal substring
    // "tool_calls" as part of its own detection regex (defense-in-depth
    // against a model embedding a tool-call-shaped string) - that is
    // scanning for the pattern, not defining an outgoing tools array, so it
    // is intentionally excluded from this specific check and covered
    // instead by cc-knowledge-security.test.js.
    if (fileName === "cc-knowledge-handler.js") continue;
    assert.ok(!/tool_calls|tools:\s*\[/.test(source), `${fileName} must not define tool-calling constructs`);
  }
  const handlerSource = readOrchestratorFile("cc-knowledge-handler.js");
  assert.ok(!/\btools\s*:\s*\[/.test(handlerSource), "cc-knowledge-handler.js must never define an outgoing tools array");
});

test("cc-knowledge-rag-service.js calls the embedding client and search module, not a chat/answer adapter", () => {
  const source = readOrchestratorFile("cc-knowledge-rag-service.js");
  assert.ok(source.includes("embedding-client.js"));
  assert.ok(source.includes("rag-search.js"));
  assert.ok(!source.includes("provider-adapters"));
  assert.ok(!source.includes("ollama-text"));
});

test("cc-knowledge-handler.js reaches Ollama only through the shared text-response pipeline, never a second client", () => {
  const source = readOrchestratorFile("cc-knowledge-handler.js");
  assert.ok(source.includes("text-response-handler.js"));
  assert.ok(!source.includes("provider-adapters/ollama-text"));
  assert.ok(!/AI_ROUTER_OLLAMA_BASE_URL\s*=\s*["']http/.test(source), "must not hardcode or override the Ollama base URL");
});

// Functional coverage for "no caller-controllable threshold/top-k/snippet
// field" lives in cc-knowledge-contract.test.js (it actually submits such
// fields and asserts rejection) - a source-text grep here would also match
// this file's own explanatory comments about why those fields don't exist,
// so it is intentionally not duplicated as a static check.
