import test from "node:test";
import assert from "node:assert/strict";
import { verifyIndexFreshness } from "../orchestrator/knowledge/rag-index-freshness.js";
import { buildIndexFingerprint } from "../orchestrator/knowledge/rag-fingerprint.js";
import {
  RAG_CHUNKING_VERSION,
  RAG_INDEX_SCHEMA_VERSION
} from "../orchestrator/knowledge/rag-config.js";

const NOW = new Date("2026-08-14T00:00:00.000Z");
const MODEL = "bge-m3:latest";
const DIGEST = `sha256:${"a".repeat(64)}`;

function allowlist(paths = ["a.md", "b.md"], rejected = []) {
  return {
    schemaVersion: "1.0",
    documents: paths.map((relativePath) => ({ relativePath })),
    rejected
  };
}

function manifestFor(list = allowlist()) {
  return {
    schemaVersion: RAG_INDEX_SCHEMA_VERSION,
    documents: Object.fromEntries(list.documents.map(({ relativePath }, index) => [relativePath, {
      status: "ok",
      contentHash: `sha256:doc-${index}`,
      chunkCount: 1
    }]))
  };
}

function chunksFor(list, manifest) {
  return list.documents.map(({ relativePath }) => ({
    sourceDoc: relativePath,
    contentHash: manifest.documents[relativePath].contentHash,
    embeddingModel: MODEL,
    embedding: [1, 2, 3]
  }));
}

function indexFixture({ builtAt = "2026-08-13T23:00:00.000Z" } = {}) {
  const indexedAllowlist = allowlist();
  const manifest = manifestFor(indexedAllowlist);
  const chunks = chunksFor(indexedAllowlist, manifest);
  const fingerprint = buildIndexFingerprint({
    allowlist: indexedAllowlist,
    manifestDocuments: manifest.documents,
    embeddingModel: MODEL,
    embeddingModelDigest: DIGEST,
    embeddingDimensions: 3,
    chunkCount: chunks.length
  });
  return {
    indexedAllowlist,
    manifest,
    chunks,
    meta: {
      schemaVersion: RAG_INDEX_SCHEMA_VERSION,
      embeddingModel: MODEL,
      embeddingModelDigest: DIGEST,
      embeddingDimensions: 3,
      chunkingVersion: RAG_CHUNKING_VERSION,
      fingerprint,
      lastBuiltAt: builtAt
    }
  };
}

function verify(fixture, overrides = {}) {
  const currentAllowlist = overrides.currentAllowlist || fixture.indexedAllowlist;
  return verifyIndexFreshness({
    env: { AI_ROUTER_VAULT_ROOT: "C:\\vault" },
    now: () => NOW,
    meta: overrides.meta || fixture.meta,
    manifest: overrides.manifest || fixture.manifest,
    chunks: overrides.chunks || fixture.chunks,
    modelIdentity: overrides.modelIdentity || { model: MODEL, digest: DIGEST },
    loadAllowlistFn: () => currentAllowlist,
    loadVaultDocumentFn: (_root, relativePath) => {
      if (overrides.missingPath === relativePath) return { exists: false, relativePath };
      if (overrides.documentErrorPath === relativePath) throw new Error("unreadable");
      const indexedHash = fixture.manifest.documents[relativePath]?.contentHash || "sha256:new-doc";
      const contentHash = overrides.changedPath === relativePath ? `${indexedHash}-changed` : indexedHash;
      return { exists: true, relativePath, contentHash };
    }
  });
}

test("unchanged documents and an old index are content_current with only an age warning", () => {
  const fixture = indexFixture({ builtAt: "2026-08-10T00:00:00.000Z" });
  const result = verify(fixture);
  assert.equal(result.state, "content_current");
  assert.equal(result.ageWarning, true);
  assert.equal(result.modelDigestVerified, true);
  assert.equal(result.lastVerifiedAt, NOW.toISOString());
});

test("a document changed after reindex is content_stale", () => {
  const fixture = indexFixture();
  const result = verify(fixture, { changedPath: "a.md" });
  assert.equal(result.state, "content_stale");
  assert.ok(result.reasons.includes("document_content_changed"));
});

test("a semantically observable allowlist reorder is content_stale", () => {
  const fixture = indexFixture();
  const result = verify(fixture, { currentAllowlist: allowlist(["b.md", "a.md"]) });
  assert.equal(result.state, "content_stale");
  assert.ok(result.reasons.includes("allowlist_changed"));
});

test("an allowlist addition is content_stale, not silently current", () => {
  const fixture = indexFixture();
  const result = verify(fixture, { currentAllowlist: allowlist(["a.md", "b.md", "c.md"]) });
  assert.equal(result.state, "content_stale");
  assert.ok(result.reasons.includes("allowlist_changed"));
  assert.ok(result.reasons.includes("manifest_document_missing"));
});

test("an allowlist removal is content_stale", () => {
  const fixture = indexFixture();
  const result = verify(fixture, { currentAllowlist: allowlist(["a.md"]) });
  assert.equal(result.state, "content_stale");
  assert.ok(result.reasons.includes("allowlist_changed"));
});

test("a missing allowlisted document is content_stale", () => {
  const fixture = indexFixture();
  const result = verify(fixture, { missingPath: "a.md" });
  assert.equal(result.state, "content_stale");
  assert.ok(result.reasons.includes("document_missing"));
});

test("an index schema mismatch is index_incompatible", () => {
  const fixture = indexFixture();
  const result = verify(fixture, { meta: { ...fixture.meta, schemaVersion: "old" } });
  assert.equal(result.state, "index_incompatible");
  assert.ok(result.reasons.includes("index_schema_mismatch"));
});

test("a chunking version mismatch is index_incompatible", () => {
  const fixture = indexFixture();
  const result = verify(fixture, { meta: { ...fixture.meta, chunkingVersion: "old" } });
  assert.equal(result.state, "index_incompatible");
  assert.ok(result.reasons.includes("chunking_version_mismatch"));
});

test("an embedding dimension mismatch is index_incompatible", () => {
  const fixture = indexFixture();
  const result = verify(fixture, { meta: { ...fixture.meta, embeddingDimensions: 4 } });
  assert.equal(result.state, "index_incompatible");
  assert.ok(result.reasons.includes("embedding_dimensions_mismatch"));
});

test("an embedding model digest change is index_incompatible", () => {
  const fixture = indexFixture();
  const result = verify(fixture, { modelIdentity: { model: MODEL, digest: `sha256:${"b".repeat(64)}` } });
  assert.equal(result.state, "index_incompatible");
  assert.ok(result.reasons.includes("embedding_model_digest_mismatch"));
});

test("an embedding model name change is index_incompatible", () => {
  const fixture = indexFixture();
  const result = verify(fixture, { modelIdentity: { model: "different:latest", digest: DIGEST } });
  assert.equal(result.state, "index_incompatible");
  assert.ok(result.reasons.includes("embedding_model_mismatch"));
});

test("chunks built with a different embedding model are index_incompatible", () => {
  const fixture = indexFixture();
  const chunks = fixture.chunks.map((chunk, index) => index === 0
    ? { ...chunk, embeddingModel: "different:latest" }
    : chunk);
  const result = verify(fixture, { chunks });
  assert.equal(result.state, "index_incompatible");
  assert.ok(result.reasons.includes("chunk_embedding_model_mismatch"));
});

test("an unavailable model digest is explicit residual uncertainty, not false staleness", () => {
  const fixture = indexFixture();
  const meta = {
    ...fixture.meta,
    embeddingModelDigest: null,
    fingerprint: buildIndexFingerprint({
      allowlist: fixture.indexedAllowlist,
      manifestDocuments: fixture.manifest.documents,
      embeddingModel: MODEL,
      embeddingModelDigest: null,
      embeddingDimensions: 3,
      chunkCount: fixture.chunks.length
    })
  };
  const result = verify(fixture, { meta, modelIdentity: { model: MODEL, digest: null } });
  assert.equal(result.state, "content_current");
  assert.equal(result.modelDigestVerified, false);
  assert.ok(result.reasons.includes("embedding_model_digest_unavailable"));
});

test("a manifest document error cannot be content_current", () => {
  const fixture = indexFixture();
  const manifest = structuredClone(fixture.manifest);
  manifest.documents["a.md"].status = "error";
  manifest.documents["a.md"].lastErrorCode = "DOCUMENT_UNREADABLE";
  const result = verify(fixture, { manifest });
  assert.equal(result.state, "index_error");
  assert.ok(result.reasons.includes("manifest_document_not_ok"));
});

test("a per-document manifest chunk-count mismatch is index_error", () => {
  const fixture = indexFixture();
  const manifest = structuredClone(fixture.manifest);
  manifest.documents["a.md"].chunkCount = 2;
  const result = verify(fixture, { manifest });
  assert.equal(result.state, "index_error");
  assert.ok(result.reasons.includes("manifest_chunk_count_mismatch"));
});

test("rejected effective allowlist entries are index_error", () => {
  const fixture = indexFixture();
  const result = verify(fixture, {
    currentAllowlist: allowlist(["a.md", "b.md"], [{ relativePath: "bad.md", code: "ALLOWLIST_ENTRY_UNSAFE_PATH" }])
  });
  assert.equal(result.state, "index_error");
  assert.ok(result.reasons.includes("allowlist_entries_rejected"));
});
