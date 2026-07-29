import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KNOWLEDGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "orchestrator", "knowledge");
const ANSWER_PIPELINE_MODULES = ["text-response-handler.js", "text-response-service.js", "cc-summary-handler.js", "cc-summary-service.js", "router-service.js", "router-console-proxy.js"];
const WRITE_CALL_PATTERN = /\bfs\.(writeFile(?:Sync)?|appendFile(?:Sync)?|rename(?:Sync)?|rm(?:Sync)?|unlink(?:Sync)?|mkdir(?:Sync)?)\b/;

function knowledgeFiles() {
  return fs.readdirSync(KNOWLEDGE_DIR).filter((name) => name.endsWith(".js"));
}

test("no module under orchestrator/knowledge/ is imported by the existing answer pipeline", () => {
  const orchestratorDir = path.join(KNOWLEDGE_DIR, "..");
  for (const moduleName of ANSWER_PIPELINE_MODULES) {
    const filePath = path.join(orchestratorDir, moduleName);
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    assert.ok(!source.includes("knowledge/"), `${moduleName} must not import from orchestrator/knowledge/`);
  }
});

test("no knowledge module writes to a path outside .ai-router-data (heuristic source scan)", () => {
  for (const fileName of knowledgeFiles()) {
    const source = fs.readFileSync(path.join(KNOWLEDGE_DIR, fileName), "utf8");
    const match = WRITE_CALL_PATTERN.exec(source);
    if (!match) continue;
    // rag-index-store.js is the only module allowed to perform filesystem
    // writes at all, and only ever under RAG_INDEX_DIR (.ai-router-data).
    assert.equal(fileName, "rag-index-store.js", `${fileName} contains an unexpected filesystem write call (${match[0]})`);
  }
});

test("document-loader.js contains no write/rename/unlink call on vault paths", () => {
  const source = fs.readFileSync(path.join(KNOWLEDGE_DIR, "document-loader.js"), "utf8");
  assert.ok(!WRITE_CALL_PATTERN.test(source));
});

test("rag-indexer.js contains no write/rename/unlink call directly (delegates to rag-index-store)", () => {
  const source = fs.readFileSync(path.join(KNOWLEDGE_DIR, "rag-indexer.js"), "utf8");
  assert.ok(!WRITE_CALL_PATTERN.test(source));
});
