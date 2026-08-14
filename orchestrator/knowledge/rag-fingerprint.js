import crypto from "node:crypto";
import {
  RAG_CHUNKING_VERSION,
  RAG_FINGERPRINT_VERSION,
  RAG_INDEX_SCHEMA_VERSION,
  RAG_MAX_CHUNK_CHARS,
  RAG_MAX_CHUNKS_PER_DOCUMENT,
  RAG_MIN_MERGE_CHARS,
  RAG_TARGET_CHUNK_CHARS
} from "./rag-config.js";

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

// Order is deliberately retained. It is observable for exact-similarity
// ties because the in-memory search is stable and chunks follow allowlist
// order; reordering can therefore change which tied result is returned.
export function canonicalAllowlistIdentity(allowlist) {
  return Object.freeze({
    schemaVersion: allowlist.schemaVersion,
    documents: Object.freeze(allowlist.documents.map((entry) => entry.relativePath))
  });
}

export function buildAllowlistHash(allowlist) {
  return sha256(canonicalAllowlistIdentity(allowlist));
}

export function canonicalDocumentIdentity(allowlist, manifestDocuments = {}) {
  return Object.freeze(allowlist.documents.map(({ relativePath }) => {
    const entry = manifestDocuments[relativePath] || {};
    return Object.freeze({
      relativePath,
      status: typeof entry.status === "string" ? entry.status : null,
      contentHash: typeof entry.contentHash === "string" ? entry.contentHash : null
    });
  }));
}

export function buildDocumentsHash(allowlist, manifestDocuments = {}) {
  return sha256(canonicalDocumentIdentity(allowlist, manifestDocuments));
}

export function canonicalBuildIdentity({ embeddingModel, embeddingModelDigest = null, embeddingDimensions }) {
  return Object.freeze({
    indexSchemaVersion: RAG_INDEX_SCHEMA_VERSION,
    chunkingVersion: RAG_CHUNKING_VERSION,
    chunking: Object.freeze({
      maxChunkChars: RAG_MAX_CHUNK_CHARS,
      targetChunkChars: RAG_TARGET_CHUNK_CHARS,
      minMergeChars: RAG_MIN_MERGE_CHARS,
      maxChunksPerDocument: RAG_MAX_CHUNKS_PER_DOCUMENT
    }),
    embeddingModel,
    embeddingModelDigest,
    embeddingDimensions
  });
}

export function buildBuildConfigHash(options) {
  return sha256(canonicalBuildIdentity(options));
}

export function buildIndexFingerprint({
  allowlist,
  manifestDocuments,
  embeddingModel,
  embeddingModelDigest = null,
  embeddingDimensions,
  chunkCount
}) {
  return Object.freeze({
    version: RAG_FINGERPRINT_VERSION,
    allowlistHash: buildAllowlistHash(allowlist),
    documentsHash: buildDocumentsHash(allowlist, manifestDocuments),
    buildConfigHash: buildBuildConfigHash({ embeddingModel, embeddingModelDigest, embeddingDimensions }),
    chunkCount
  });
}

export const ragFingerprintInternals = Object.freeze({ sha256 });
