import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated AI_ROUTER_DATA_DIR per file, set before the first import of
// anything depending on orchestrator/config.js's module-level DATA_DIR, so
// this file's chunks.jsonl/manifest.json never collide with another test
// file's index directory.
process.env.AI_ROUTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rag-index-store-"));

const {
  acquireIndexLock,
  releaseIndexLock,
  readAllChunks,
  readIndexMeta,
  readManifest,
  writeAllChunks,
  writeIndexMeta,
  writeManifest
} = await import("../orchestrator/knowledge/rag-index-store.js");
const { RagError } = await import("../orchestrator/knowledge/rag-error.js");
const { RAG_CHUNKS_FILE, RAG_MANIFEST_FILE } = await import("../orchestrator/knowledge/rag-config.js");

test("manifest and index-meta round-trip through write/read", () => {
  writeManifest({ schemaVersion: "1.0", documents: { "x.md": { status: "ok" } } });
  writeIndexMeta({ schemaVersion: "1.0", embeddingModel: "bge-m3" });
  assert.equal(readManifest().documents["x.md"].status, "ok");
  assert.equal(readIndexMeta().embeddingModel, "bge-m3");
});

test("missing manifest returns a safe empty default instead of throwing", () => {
  fs.rmSync(RAG_MANIFEST_FILE, { force: true });
  const manifest = readManifest();
  assert.deepEqual(manifest.documents, {});
});

test("chunks round-trip through writeAllChunks/readAllChunks", () => {
  writeAllChunks([{ chunkId: "a", sourceDoc: "x.md" }, { chunkId: "b", sourceDoc: "y.md" }]);
  const chunks = readAllChunks();
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].chunkId, "a");
});

test("corrupt chunks file throws INDEX_CORRUPT instead of crashing", () => {
  fs.mkdirSync(path.dirname(RAG_CHUNKS_FILE), { recursive: true });
  fs.writeFileSync(RAG_CHUNKS_FILE, "not valid json\n");
  assert.throws(() => readAllChunks(), (error) => error instanceof RagError && error.code === "INDEX_CORRUPT");
});

test("corrupt manifest file throws MANIFEST_CORRUPT instead of crashing", () => {
  fs.mkdirSync(path.dirname(RAG_MANIFEST_FILE), { recursive: true });
  fs.writeFileSync(RAG_MANIFEST_FILE, "{not json");
  assert.throws(() => readManifest(), (error) => error.code === "MANIFEST_CORRUPT");
});

test("acquireIndexLock blocks a second concurrent run", () => {
  fs.rmSync(RAG_MANIFEST_FILE, { force: true });
  acquireIndexLock();
  try {
    assert.throws(() => acquireIndexLock(), (error) => error instanceof RagError && error.code === "INDEX_LOCKED");
  } finally {
    releaseIndexLock();
  }
});

test("releaseIndexLock allows a subsequent run to acquire again", () => {
  acquireIndexLock();
  releaseIndexLock();
  acquireIndexLock();
  releaseIndexLock();
});
