import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORCHESTRATOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "orchestrator");
const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "api", "v1", "cc");
// Covers both knowledge paths. The shared engine modules
// (knowledge-answer-*) and the generic route modules (knowledge-*) must
// obey the identical read-only guarantees as the CC-specific ones
// (cc-knowledge-*) - listing them all here is what stops either the
// extraction or the 2026-08-12 rename from becoming a way to acquire
// capabilities the Command Center path was never allowed.
const CC_KNOWLEDGE_FILES = [
  "cc-knowledge-config.js", "cc-knowledge-error.js", "cc-knowledge-contract.js", "cc-knowledge-handler.js",
  "knowledge-answer-config.js", "knowledge-answer-rag-service.js", "knowledge-answer-prompt.js", "knowledge-answer-response.js",
  "knowledge-config.js", "knowledge-error.js", "knowledge-contract.js",
  "knowledge-service.js", "knowledge-handler.js",
  // P1-A3: the authority/time model. Listed here so the new module inherits
  // the same read-only guarantees as every other knowledge module rather
  // than becoming a way to acquire capabilities around them.
  "knowledge-authority.js"
];
const WRITE_CALL_PATTERN = /\bfs\.(writeFile(?:Sync)?|appendFile(?:Sync)?|rename(?:Sync)?|rm(?:Sync)?|unlink(?:Sync)?|mkdir(?:Sync)?)\b/;

function readOrchestratorFile(name) {
  return fs.readFileSync(path.join(ORCHESTRATOR_DIR, name), "utf8");
}

// Same distinction the import checks above already make: a module that
// explains in prose why it deliberately does NOT use something must not be
// failed for naming it. Strips block and line comments so an assertion can
// address executable code only.
function readOrchestratorCode(name) {
  return readOrchestratorFile(name).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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

test("knowledge-answer-rag-service.js never imports the vault document loader or the re-indexer", () => {
  const source = readOrchestratorFile("knowledge-answer-rag-service.js");
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
    // knowledge-service.js legitimately contains the literal substring
    // "tool_calls" as part of its own detection regex (defense-in-depth
    // against a model embedding a tool-call-shaped string) - that is
    // scanning for the pattern, not defining an outgoing tools array, so it
    // is intentionally excluded from this specific check and covered
    // instead by cc-knowledge-security.test.js. The exclusion moved from
    // cc-knowledge-handler.js to knowledge-service.js with the extraction;
    // the handler is no longer exempt.
    if (fileName === "knowledge-service.js") continue;
    assert.ok(!/tool_calls|tools:\s*\[/.test(source), `${fileName} must not define tool-calling constructs`);
  }
  const serviceSource = readOrchestratorFile("knowledge-service.js");
  assert.ok(!/\btools\s*:\s*\[/.test(serviceSource), "knowledge-service.js must never define an outgoing tools array");
});

test("knowledge-answer-rag-service.js calls the embedding client and search module, not a chat/answer adapter", () => {
  const source = readOrchestratorFile("knowledge-answer-rag-service.js");
  assert.ok(source.includes("embedding-client.js"));
  assert.ok(source.includes("rag-search.js"));
  assert.ok(!source.includes("provider-adapters"));
  assert.ok(!source.includes("ollama-text"));
});

// The pipeline reference moved into knowledge-service.js with the
// extraction. Asserting it there - and asserting that NO knowledge module
// reaches for a second client - is strictly stronger than the previous
// single-file check.
test("the knowledge engine reaches Ollama only through the shared text-response pipeline, never a second client", () => {
  const source = readOrchestratorFile("knowledge-service.js");
  assert.ok(source.includes("text-response-handler.js"));
  for (const fileName of CC_KNOWLEDGE_FILES) {
    const moduleSource = readOrchestratorFile(fileName);
    assert.ok(!moduleSource.includes("provider-adapters/ollama-text"), `${fileName} must not reach a provider adapter directly`);
    assert.ok(!/AI_ROUTER_OLLAMA_BASE_URL\s*=\s*["']http/.test(moduleSource), `${fileName} must not hardcode or override the Ollama base URL`);
  }
});

// The whole point of the separate token: holding the generic route's token
// must never be a way into the Command Center's /api/v1/cc/* routes.
test("the generic knowledge route uses its own token, never AI_ROUTER_CC_TOKEN", () => {
  const code = readOrchestratorCode("knowledge-handler.js");
  assert.ok(!code.includes("AI_ROUTER_CC_TOKEN"), "the generic route must not read the Command Center token");
  assert.ok(code.includes("KNOWLEDGE_TOKEN_ENV_VAR"), "the generic route must read its own token constant");
  assert.ok(readOrchestratorCode("knowledge-config.js").includes("AI_ROUTER_KNOWLEDGE_TOKEN"));
  // And the reverse direction: the CC route keeps reading its own token.
  assert.ok(readOrchestratorCode("cc-knowledge-handler.js").includes("AI_ROUTER_CC_TOKEN"));
});

// Personal knowledge content must never leave the machine. The service pins
// the provider to Ollama rather than honouring the shared provider switch.
test("the knowledge engine pins the provider to Ollama and cannot be switched to a cloud provider", () => {
  const source = readOrchestratorFile("knowledge-service.js");
  assert.ok(/AI_ROUTER_TEXT_PROVIDER:\s*["']ollama["']/.test(source), "the engine must force the Ollama provider");
});

test("server.js wires the generic knowledge route exactly once", () => {
  const source = readOrchestratorFile("server.js");
  const matches = source.match(/pathname === "\/api\/v1\/knowledge"/g) || [];
  assert.equal(matches.length, 1, "the generic route path must be wired exactly once");
});

// Guards the explicit scope of this step: the CC contract keeps its own
// request shape, including the context field the generic contract has not.
test("the generic contract has no context field and the CC contract still does", () => {
  assert.ok(readOrchestratorFile("cc-knowledge-contract.js").includes('"context"'));
  assert.ok(!readOrchestratorFile("knowledge-contract.js").includes('"context"'));
});

// Functional coverage for "no caller-controllable threshold/top-k/snippet
// field" lives in cc-knowledge-contract.test.js (it actually submits such
// fields and asserts rejection) - a source-text grep here would also match
// this file's own explanatory comments about why those fields don't exist,
// so it is intentionally not duplicated as a static check.
