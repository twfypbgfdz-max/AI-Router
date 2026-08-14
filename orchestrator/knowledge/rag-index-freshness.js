import { loadAllowlist } from "./document-allowlist.js";
import { loadVaultDocument } from "./document-loader.js";
import {
  buildAllowlistHash,
  buildBuildConfigHash,
  buildDocumentsHash
} from "./rag-fingerprint.js";
import {
  RAG_ALLOWLIST_FILE,
  RAG_CHUNKING_VERSION,
  RAG_FINGERPRINT_VERSION,
  RAG_INDEX_SCHEMA_VERSION
} from "./rag-config.js";
import { KNOWLEDGE_ANSWER_INDEX_MAX_AGE_MS } from "../knowledge-answer-config.js";

const INDEX_STATES = new Set(["content_current", "content_stale", "index_incompatible", "index_error"]);

function result(state, {
  reasons = [],
  lastBuiltAt = null,
  lastVerifiedAt,
  ageWarning = false,
  modelDigestVerified = false,
  allowedSourceDocs = [],
  sourceMetadata = {}
} = {}) {
  if (!INDEX_STATES.has(state)) throw new Error(`Unknown index freshness state: ${state}`);
  return Object.freeze({
    state,
    reasons: Object.freeze([...new Set(reasons)]),
    lastBuiltAt,
    lastVerifiedAt,
    ageWarning,
    modelDigestVerified,
    allowedSourceDocs: Object.freeze([...allowedSourceDocs]),
    // Per-document authority metadata for the answer path, read from the
    // same already-loaded allowlist as allowedSourceDocs. It is deliberately
    // resolved here rather than at index time: these values do not influence
    // any embedding, so binding them to the request instead of to the index
    // means a class or review-date correction takes effect immediately and
    // never requires a re-index.
    sourceMetadata: Object.freeze({ ...sourceMetadata })
  });
}

function builtAtFrom(meta) {
  const value = meta?.lastBuiltAt || meta?.lastRunAt || null;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function dimensionsAreCompatible(chunks, expected) {
  return Number.isSafeInteger(expected) && expected > 0
    && chunks.every((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length === expected);
}

// Read-only verification of the already-built index against today's
// effective allowlist and document bytes. It performs no chunking and no
// embeddings. At the deliberately small allowlist size, hashing each
// bounded document on every request gives immediate change detection
// without the false negatives an mtime-only cache could introduce.
export function verifyIndexFreshness({
  env = process.env,
  now = () => new Date(),
  meta,
  manifest,
  chunks,
  modelIdentity = null,
  allowlistFilePath = RAG_ALLOWLIST_FILE,
  loadAllowlistFn = loadAllowlist,
  loadVaultDocumentFn = loadVaultDocument
} = {}) {
  const verifiedAt = now();
  const lastVerifiedAt = verifiedAt.toISOString();
  const lastBuiltAt = builtAtFrom(meta);
  const ageWarning = lastBuiltAt
    ? verifiedAt.getTime() - Date.parse(lastBuiltAt) > KNOWLEDGE_ANSWER_INDEX_MAX_AGE_MS
    : false;
  const incompatible = [];
  const errors = [];
  const stale = [];

  if (!meta || !manifest || !Array.isArray(chunks) || chunks.length === 0) {
    return result("index_error", { reasons: ["index_files_missing"], lastBuiltAt, lastVerifiedAt, ageWarning });
  }
  if (meta.schemaVersion !== RAG_INDEX_SCHEMA_VERSION || manifest.schemaVersion !== RAG_INDEX_SCHEMA_VERSION) {
    incompatible.push("index_schema_mismatch");
  }
  if (meta.chunkingVersion !== RAG_CHUNKING_VERSION) incompatible.push("chunking_version_mismatch");
  if (meta.fingerprint?.version !== RAG_FINGERPRINT_VERSION) incompatible.push("fingerprint_version_mismatch");
  if (meta.embeddingModel !== modelIdentity?.model) incompatible.push("embedding_model_mismatch");
  if (!dimensionsAreCompatible(chunks, meta.embeddingDimensions)) incompatible.push("embedding_dimensions_mismatch");
  if (chunks.some((chunk) => chunk.embeddingModel !== meta.embeddingModel)) incompatible.push("chunk_embedding_model_mismatch");
  if (meta.fingerprint?.chunkCount !== chunks.length) errors.push("chunk_count_mismatch");

  const indexedDigest = typeof meta.embeddingModelDigest === "string" ? meta.embeddingModelDigest : null;
  const currentDigest = typeof modelIdentity?.digest === "string" ? modelIdentity.digest : null;
  const modelDigestVerified = Boolean(indexedDigest && currentDigest && indexedDigest === currentDigest);
  if (indexedDigest && currentDigest && indexedDigest !== currentDigest) {
    incompatible.push("embedding_model_digest_mismatch");
  }

  if (Number.isSafeInteger(meta.embeddingDimensions) && meta.embeddingDimensions > 0) {
    const expectedBuildHash = buildBuildConfigHash({
      embeddingModel: meta.embeddingModel,
      embeddingModelDigest: indexedDigest,
      embeddingDimensions: meta.embeddingDimensions
    });
    if (meta.fingerprint?.buildConfigHash !== expectedBuildHash) incompatible.push("build_config_mismatch");
  }

  if (incompatible.length > 0) {
    return result("index_incompatible", {
      reasons: incompatible,
      lastBuiltAt,
      lastVerifiedAt,
      ageWarning,
      modelDigestVerified
    });
  }

  const vaultRoot = typeof env.AI_ROUTER_VAULT_ROOT === "string" ? env.AI_ROUTER_VAULT_ROOT.trim() : "";
  if (!vaultRoot) {
    return result("index_error", {
      reasons: ["vault_root_unavailable"], lastBuiltAt, lastVerifiedAt, ageWarning, modelDigestVerified
    });
  }

  let allowlist;
  try {
    allowlist = loadAllowlistFn(allowlistFilePath);
  } catch {
    return result("index_error", {
      reasons: ["allowlist_unreadable"], lastBuiltAt, lastVerifiedAt, ageWarning, modelDigestVerified
    });
  }
  const allowedSourceDocs = allowlist.documents.map(({ relativePath }) => relativePath);
  const sourceMetadata = Object.fromEntries(allowlist.documents.map(({ relativePath, informationClass, reviewedAt }) =>
    [relativePath, Object.freeze({ informationClass, reviewedAt })]));
  if (allowlist.rejected.length > 0) errors.push("allowlist_entries_rejected");
  if (meta.fingerprint?.allowlistHash !== buildAllowlistHash(allowlist)) stale.push("allowlist_changed");

  const currentDocuments = {};
  const allowedPaths = new Set(allowedSourceDocs);
  const chunksPerDocument = new Map();
  for (const chunk of chunks) {
    chunksPerDocument.set(chunk.sourceDoc, (chunksPerDocument.get(chunk.sourceDoc) || 0) + 1);
  }
  for (const { relativePath } of allowlist.documents) {
    const manifestEntry = manifest.documents?.[relativePath];
    if (!manifestEntry) {
      stale.push("manifest_document_missing");
      continue;
    }
    if (manifestEntry.status !== "ok" || typeof manifestEntry.contentHash !== "string") {
      errors.push("manifest_document_not_ok");
      continue;
    }
    if (!Number.isSafeInteger(manifestEntry.chunkCount)
      || manifestEntry.chunkCount !== (chunksPerDocument.get(relativePath) || 0)) {
      errors.push("manifest_chunk_count_mismatch");
    }
    let document;
    try {
      document = loadVaultDocumentFn(vaultRoot, relativePath);
    } catch {
      errors.push("document_verification_failed");
      continue;
    }
    if (!document?.exists) {
      stale.push("document_missing");
      continue;
    }
    currentDocuments[relativePath] = { status: "ok", contentHash: document.contentHash };
    if (document.contentHash !== manifestEntry.contentHash) stale.push("document_content_changed");
  }

  if (Object.keys(currentDocuments).length === allowlist.documents.length
    && meta.fingerprint?.documentsHash !== buildDocumentsHash(allowlist, currentDocuments)) {
    stale.push("document_fingerprint_changed");
  }

  // Chunks kept after a per-document failure are explicitly stale. They may
  // still support a last-known-good answer, but never qualify as current.
  for (const chunk of chunks) {
    if (!allowedPaths.has(chunk.sourceDoc)) continue;
    const manifestEntry = manifest.documents?.[chunk.sourceDoc];
    if (!manifestEntry || manifestEntry.status !== "ok"
      || chunk.contentHash !== manifestEntry.contentHash) {
      errors.push("chunk_manifest_mismatch");
    }
  }

  if (errors.length > 0) {
    return result("index_error", { reasons: errors, lastBuiltAt, lastVerifiedAt, ageWarning, modelDigestVerified, allowedSourceDocs, sourceMetadata });
  }
  if (stale.length > 0) {
    return result("content_stale", { reasons: stale, lastBuiltAt, lastVerifiedAt, ageWarning, modelDigestVerified, allowedSourceDocs, sourceMetadata });
  }
  return result("content_current", {
    reasons: currentDigest ? [] : ["embedding_model_digest_unavailable"],
    lastBuiltAt,
    lastVerifiedAt,
    ageWarning,
    modelDigestVerified,
    allowedSourceDocs,
    sourceMetadata
  });
}

export const ragIndexFreshnessInternals = Object.freeze({ builtAtFrom, dimensionsAreCompatible });
