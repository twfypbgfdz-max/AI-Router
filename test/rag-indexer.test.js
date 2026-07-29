import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.AI_ROUTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rag-indexer-"));

const { runRagReindex } = await import("../orchestrator/knowledge/rag-indexer.js");
const { acquireIndexLock, releaseIndexLock, readManifest, readAllChunks } = await import("../orchestrator/knowledge/rag-index-store.js");
const { RagError } = await import("../orchestrator/knowledge/rag-error.js");

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "rag-vault");

function baseEnv(overrides = {}) {
  return {
    AI_ROUTER_VAULT_ROOT: FIXTURES_DIR,
    AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "bge-m3",
    AI_ROUTER_OLLAMA_BASE_URL: "http://localhost:11434",
    ...overrides
  };
}

function fixtureAllowlist(relativePaths) {
  return async () => ({ schemaVersion: "1.0", documents: relativePaths.map((relativePath) => ({ relativePath })), rejected: [] });
}

function countingEmbedder() {
  const calls = [];
  const embedTextFn = async (text) => {
    calls.push(text);
    return [text.length % 7, 1, 2];
  };
  return { embedTextFn, calls };
}

const noopAvailability = async () => {};

test("fresh run indexes allowlisted documents and calls the embedder", async () => {
  const { embedTextFn, calls } = countingEmbedder();
  const result = await runRagReindex({
    env: baseEnv(),
    loadAllowlistFn: fixtureAllowlist(["10_Apps/decision-doc.md", "10_Apps/second-doc.md"]),
    embedTextFn,
    assertEmbeddingModelAvailableFn: noopAvailability
  });
  assert.ok(calls.length > 0);
  assert.equal(result.documentsProcessed, 2);
  const manifest = readManifest();
  assert.equal(manifest.documents["10_Apps/decision-doc.md"].status, "ok");
  assert.equal(manifest.documents["10_Apps/second-doc.md"].status, "ok");
  const chunks = readAllChunks();
  assert.ok(chunks.every((c) => c.section !== undefined));
});

test("unchanged documents are skipped on a second run - no new embedding calls", async () => {
  const first = countingEmbedder();
  await runRagReindex({
    env: baseEnv(),
    loadAllowlistFn: fixtureAllowlist(["10_Apps/decision-doc.md"]),
    embedTextFn: first.embedTextFn,
    assertEmbeddingModelAvailableFn: noopAvailability
  });
  const second = countingEmbedder();
  await runRagReindex({
    env: baseEnv(),
    loadAllowlistFn: fixtureAllowlist(["10_Apps/decision-doc.md"]),
    embedTextFn: second.embedTextFn,
    assertEmbeddingModelAvailableFn: noopAvailability
  });
  assert.equal(second.calls.length, 0);
});

test("removing a document from the allowlist purges its chunks", async () => {
  const first = countingEmbedder();
  await runRagReindex({
    env: baseEnv(),
    loadAllowlistFn: fixtureAllowlist(["10_Apps/decision-doc.md", "10_Apps/second-doc.md"]),
    embedTextFn: first.embedTextFn,
    assertEmbeddingModelAvailableFn: noopAvailability
  });
  const second = countingEmbedder();
  await runRagReindex({
    env: baseEnv(),
    loadAllowlistFn: fixtureAllowlist(["10_Apps/decision-doc.md"]),
    embedTextFn: second.embedTextFn,
    assertEmbeddingModelAvailableFn: noopAvailability
  });
  const chunks = readAllChunks();
  assert.ok(!chunks.some((c) => c.sourceDoc === "10_Apps/second-doc.md"));
  const manifest = readManifest();
  assert.equal(manifest.documents["10_Apps/second-doc.md"].status, "removed");
});

test("a model change forces a full re-index of every allowlisted document", async () => {
  const first = countingEmbedder();
  await runRagReindex({
    env: baseEnv(),
    loadAllowlistFn: fixtureAllowlist(["10_Apps/decision-doc.md"]),
    embedTextFn: first.embedTextFn,
    assertEmbeddingModelAvailableFn: noopAvailability
  });
  const second = countingEmbedder();
  const result = await runRagReindex({
    env: baseEnv({ AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "other-embed-model" }),
    loadAllowlistFn: fixtureAllowlist(["10_Apps/decision-doc.md"]),
    embedTextFn: second.embedTextFn,
    assertEmbeddingModelAvailableFn: noopAvailability
  });
  assert.equal(result.forceFullReindex, true);
  assert.ok(second.calls.length > 0);
});

test("secret-like content blocks that document's chunk without aborting the run", async () => {
  const { embedTextFn, calls } = countingEmbedder();
  await runRagReindex({
    env: baseEnv(),
    loadAllowlistFn: fixtureAllowlist(["10_Apps/secret-content.md", "10_Apps/decision-doc.md"]),
    embedTextFn,
    assertEmbeddingModelAvailableFn: noopAvailability
  });
  const manifest = readManifest();
  assert.equal(manifest.documents["10_Apps/secret-content.md"].status, "error");
  assert.equal(manifest.documents["10_Apps/secret-content.md"].lastErrorCode, "DOCUMENT_SECRET_LIKE_CONTENT");
  assert.equal(manifest.documents["10_Apps/decision-doc.md"].status, "ok");
  const chunks = readAllChunks();
  assert.ok(!chunks.some((c) => c.sourceDoc === "10_Apps/secret-content.md"));
  assert.ok(calls.length > 0);
});

test("a denied-folder entry injected into the allowlist is still rejected at the loader level", async () => {
  const { embedTextFn } = countingEmbedder();
  await runRagReindex({
    env: baseEnv(),
    loadAllowlistFn: fixtureAllowlist(["60_Finanzen/secret-money.md"]),
    embedTextFn,
    assertEmbeddingModelAvailableFn: noopAvailability
  });
  const manifest = readManifest();
  assert.equal(manifest.documents["60_Finanzen/secret-money.md"].status, "error");
  assert.equal(manifest.documents["60_Finanzen/secret-money.md"].lastErrorCode, "ALLOWLIST_ENTRY_DENIED");
  const chunks = readAllChunks();
  assert.ok(!chunks.some((c) => c.sourceDoc === "60_Finanzen/secret-money.md"));
});

test("a missing allowlisted document is marked removed, not crashed", async () => {
  const { embedTextFn } = countingEmbedder();
  await runRagReindex({
    env: baseEnv(),
    loadAllowlistFn: fixtureAllowlist(["10_Apps/does-not-exist.md"]),
    embedTextFn,
    assertEmbeddingModelAvailableFn: noopAvailability
  });
  const manifest = readManifest();
  assert.equal(manifest.documents["10_Apps/does-not-exist.md"].status, "removed");
});

test("a second concurrent run is blocked while a lock is held", async () => {
  acquireIndexLock();
  try {
    await assert.rejects(
      runRagReindex({
        env: baseEnv(),
        loadAllowlistFn: fixtureAllowlist(["10_Apps/decision-doc.md"]),
        embedTextFn: async () => [0, 1],
        assertEmbeddingModelAvailableFn: noopAvailability
      }),
      (error) => error instanceof RagError && error.code === "INDEX_LOCKED"
    );
  } finally {
    releaseIndexLock();
  }
});

test("throws VAULT_ROOT_NOT_CONFIGURED when the vault root is unset", async () => {
  await assert.rejects(
    runRagReindex({ env: baseEnv({ AI_ROUTER_VAULT_ROOT: "" }), loadAllowlistFn: fixtureAllowlist([]) }),
    (error) => error instanceof RagError && error.code === "VAULT_ROOT_NOT_CONFIGURED"
  );
});

test("throws EMBEDDING_MODEL_NOT_AVAILABLE when the model check fails", async () => {
  await assert.rejects(
    runRagReindex({
      env: baseEnv(),
      loadAllowlistFn: fixtureAllowlist(["10_Apps/decision-doc.md"]),
      embedTextFn: async () => [0],
      assertEmbeddingModelAvailableFn: async () => {
        throw new RagError("EMBEDDING_MODEL_NOT_AVAILABLE", "not installed");
      }
    }),
    (error) => error.code === "EMBEDDING_MODEL_NOT_AVAILABLE"
  );
});
