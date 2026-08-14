import { assertEmbeddingModelAvailable, embedText } from "./knowledge/embedding-client.js";
import { readAllChunks, readIndexMeta, readManifest } from "./knowledge/rag-index-store.js";
import { searchKnowledgeChunks } from "./knowledge/rag-search.js";
import { loadOllamaEmbeddingProviderConfig } from "./knowledge/rag-config.js";
import { verifyIndexFreshness } from "./knowledge/rag-index-freshness.js";
import { classifyChunkValidity, informationClassOf } from "./knowledge-authority.js";

// Everything this module is allowed to do: read the already-built local
// index, verify its fingerprint read-only against the effective allowlist
// and allowlisted vault documents, check the embedding model, embed the
// already-validated question, and search. It never triggers
// orchestrator/knowledge/rag-indexer.js, writes to the vault/index, or accepts a
// caller-supplied similarity threshold or top-k - searchKnowledgeChunks is
// always called with its own built-in defaults (RAG_DEFAULT_MIN_SIMILARITY,
// RAG_DEFAULT_TOP_K from rag-config.js), never with request-derived values.
// Content identity is evaluated before match state. A changed or partially
// failed index may still return last-known-good chunks, but all such sources
// are marked stale. Pure age never changes content identity by itself.
export async function retrieveKnowledge(question, {
  env = process.env,
  now = () => new Date(),
  readIndexMetaFn = readIndexMeta,
  readManifestFn = readManifest,
  readAllChunksFn = readAllChunks,
  assertEmbeddingModelAvailableFn = assertEmbeddingModelAvailable,
  embedTextFn = embedText,
  searchFn = searchKnowledgeChunks,
  verifyIndexFreshnessFn = verifyIndexFreshness
} = {}) {
  let embeddingConfig;
  let modelIdentity;
  try {
    embeddingConfig = loadOllamaEmbeddingProviderConfig(env);
    modelIdentity = await assertEmbeddingModelAvailableFn(embeddingConfig);
    if (!modelIdentity) modelIdentity = Object.freeze({ model: embeddingConfig.model, digest: null });
  } catch {
    return Object.freeze({ knowledgeState: "embedding_model_unavailable", results: Object.freeze([]) });
  }

  let meta;
  let manifest;
  let chunks;
  try {
    meta = readIndexMetaFn();
    manifest = readManifestFn();
    chunks = readAllChunksFn();
  } catch {
    return Object.freeze({
      knowledgeState: "search_failed",
      results: Object.freeze([]),
      indexVerification: Object.freeze({
        state: "index_error",
        reasons: Object.freeze(["index_files_unreadable"]),
        lastBuiltAt: null,
        lastVerifiedAt: now().toISOString(),
        ageWarning: false,
        modelDigestVerified: false
      })
    });
  }
  if (!meta || chunks.length === 0) {
    return Object.freeze({
      knowledgeState: "index_missing",
      results: Object.freeze([]),
      indexVerification: Object.freeze({
        state: "index_error",
        reasons: Object.freeze(["index_missing"]),
        lastBuiltAt: null,
        lastVerifiedAt: now().toISOString(),
        ageWarning: false,
        modelDigestVerified: false
      })
    });
  }

  const indexVerification = await verifyIndexFreshnessFn({
    env,
    now,
    meta,
    manifest,
    chunks,
    modelIdentity
  });
  if (indexVerification.state === "index_incompatible") {
    return Object.freeze({ knowledgeState: "search_failed", results: Object.freeze([]), indexVerification });
  }

  let embedding;
  try {
    embedding = await embedTextFn(question, embeddingConfig);
  } catch {
    return Object.freeze({ knowledgeState: "search_failed", results: Object.freeze([]), indexVerification });
  }
  if (embedding.length !== meta.embeddingDimensions) {
    return Object.freeze({
      knowledgeState: "search_failed",
      results: Object.freeze([]),
      indexVerification: Object.freeze({
        ...indexVerification,
        state: "index_incompatible",
        reasons: Object.freeze([...indexVerification.reasons, "query_embedding_dimensions_mismatch"])
      })
    });
  }

  let searchResult;
  try {
    const allowedSourceDocs = Array.isArray(indexVerification.allowedSourceDocs)
      ? new Set(indexVerification.allowedSourceDocs)
      : null;
    const searchableChunks = allowedSourceDocs
      ? chunks.filter((chunk) => allowedSourceDocs.has(chunk.sourceDoc))
      : chunks;
    searchResult = searchFn(embedding, searchableChunks);
  } catch {
    return Object.freeze({ knowledgeState: "search_failed", results: Object.freeze([]), indexVerification });
  }

  // Authority metadata is joined onto the server-built search results here,
  // exactly like freshness already was: it comes from the allowlist the
  // freshness verifier just read, never from the chunk, never from the
  // caller and never from the model. A document without metadata (only
  // possible if the index still holds a chunk the allowlist no longer
  // describes) falls back to the most restrictive class rather than to none.
  const sourceFreshness = indexVerification.state === "content_current" ? "fresh" : "stale";
  const sourceMetadata = indexVerification.sourceMetadata || {};
  const results = Object.freeze(searchResult.results.map((entry) => Object.freeze({
    ...entry,
    freshness: sourceFreshness,
    informationClass: informationClassOf(sourceMetadata[entry.sourceDoc]?.informationClass),
    reviewedAt: sourceMetadata[entry.sourceDoc]?.reviewedAt ?? null,
    sectionValidity: classifyChunkValidity(entry)
  })));
  if (indexVerification.state === "content_stale" || indexVerification.state === "index_error") {
    return Object.freeze({ knowledgeState: "index_stale", results, indexVerification });
  }
  if (results.length === 0) {
    return Object.freeze({ knowledgeState: "no_match", results, indexVerification });
  }
  return Object.freeze({ knowledgeState: "available", results, indexVerification });
}
