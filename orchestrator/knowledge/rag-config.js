import path from "node:path";
import { DATA_DIR, REPOSITORY_ROOT } from "../config.js";
import { parseOllamaLoopbackUrl } from "../ollama-loopback.js";
import { RagError } from "./rag-error.js";

// Independent schema/version counter for the RAG index - never compared to
// the router API, recommendation or cc-summary schema versions (same
// principle as cc-summary-config.js: separate contracts, separate counters).
export const RAG_INDEX_SCHEMA_VERSION = "2.0";
export const RAG_FINGERPRINT_VERSION = "1";

// Bumped whenever the shape of the text actually sent to the embedding
// model changes (e.g. adding the "Dokument: ... / Abschnitt: ..." prefix in
// chunking version 2). A mismatch against index-meta.json forces a full
// re-index, the same way an embedding model change does - this prevents
// silently mixing embeddings computed from two different text formats in
// one index. chunkId itself is deliberately NOT tied to this version: it
// identifies a chunk's position (document + section + ordinal), not the
// text format used to embed it.
export const RAG_CHUNKING_VERSION = "2";

export const RAG_INDEX_DIR = path.join(DATA_DIR, "rag-index");
export const RAG_CHUNKS_FILE = path.join(RAG_INDEX_DIR, "chunks.jsonl");
export const RAG_MANIFEST_FILE = path.join(RAG_INDEX_DIR, "manifest.json");
export const RAG_INDEX_META_FILE = path.join(RAG_INDEX_DIR, "index-meta.json");
export const RAG_LOCK_FILE = path.join(RAG_INDEX_DIR, "rag-index.lock");
export const RAG_LOCK_MAX_AGE_MS = 10 * 60_000;

export const RAG_ALLOWLIST_FILE = process.env.AI_ROUTER_RAG_ALLOWLIST_FILE
  ? path.resolve(process.env.AI_ROUTER_RAG_ALLOWLIST_FILE)
  : path.join(REPOSITORY_ROOT, "config", "rag-allowlist.json");

// Measurement-only input for `npm run rag:quality`. Never read by the
// server, the indexer or the knowledge endpoint - nothing in the request
// path depends on this file existing.
export const RAG_QUALITY_SET_FILE = process.env.AI_ROUTER_RAG_QUALITY_SET_FILE
  ? path.resolve(process.env.AI_ROUTER_RAG_QUALITY_SET_FILE)
  : path.join(REPOSITORY_ROOT, "config", "rag-quality-set.json");

export const RAG_QUALITY_MAX_CASES = 200;

// Answer-level truth/regression input for the explicit local-model eval.
// Like the retrieval quality set, this is measurement-only: production
// request handling never reads it. The runner itself deliberately invokes
// the production knowledge service instead of rebuilding that pipeline.
export const RAG_TRUTH_SET_FILE = process.env.AI_ROUTER_RAG_TRUTH_SET_FILE
  ? path.resolve(process.env.AI_ROUTER_RAG_TRUTH_SET_FILE)
  : path.join(REPOSITORY_ROOT, "config", "rag-truth-set.json");

export const RAG_TRUTH_MAX_CASES = 50;

export const RAG_MAX_ALLOWLIST_ENTRIES = 100;
export const RAG_MAX_DOCUMENT_BYTES = 200_000;
export const RAG_MAX_CHUNK_CHARS = 2_000;
export const RAG_TARGET_CHUNK_CHARS = 1_200;
export const RAG_MIN_MERGE_CHARS = 200;
export const RAG_MAX_CHUNKS_PER_DOCUMENT = 200;

// Recalibrated 2026-08-11 after the allowlist grew from 6 to 10 documents
// (109 -> 158 chunks), which the previous comment named as the trigger to
// revisit. Measured reproducibly with `npm run rag:quality` against the
// then-current 22-case set (18 positive, 4 negative). The committed set has
// since been expanded; these historical numbers document only why 0.55 was
// selected:
//
//   Schwelle   Top-1    Top-3    kein Treffer   Fehltreffer (negativ)
//   0.65       22.2%    22.2%       77.8%              0/4
//   0.60       50.0%    50.0%       27.8%              0/4   <- vorher
//   0.55       72.2%    83.3%        5.6%              0/4   <- jetzt
//   0.50       77.8%    88.9%        0.0%              0/4
//
// 0.60 was silently discarding five questions whose correct document sat
// between 0.544 and 0.589 - the threshold, not the retrieval, was the
// binding constraint. A run at threshold 0 shows a clean gap: the best
// similarity any of the four negative (deliberately unanswerable) questions
// reaches is 0.458, while the lowest correct top-1 match is 0.544.
//
// 0.50 scores better still but leaves only ~0.04 of margin above that
// observed negative maximum, measured on just four negative cases. 0.55
// keeps ~0.09 of margin for a 22-point / 33-point gain in top-1 / top-3 and
// is the deliberate choice; the negative sample is too small to justify
// spending that margin for one extra question.
//
// The two ranking weaknesses found in that calibration became the input for
// Option A (larger internal candidate pool plus deterministic document
// diversity). They are intentionally addressed without changing this
// threshold; current results always come from the committed quality set.
export const RAG_DEFAULT_MIN_SIMILARITY = 0.55;
export const RAG_DEFAULT_TOP_K = 3;
export const RAG_MAX_TOP_K = 5;
export const RAG_CANDIDATE_POOL_MULTIPLIER = 3;
export const RAG_MAX_COMBINED_SNIPPET_CHARS = 2_000;
export const RAG_MIN_PACKED_CHARS_PER_SOURCE = 256;

export const RAG_EMBEDDING_TIMEOUT_MS = 15_000;
export const RAG_EMBEDDING_MAX_BODY_BYTES = 2 * 1024 * 1024;

// Hard-coded, not configurable via the allowlist - a folder here can never
// be re-enabled by an allowlist entry, only removed from this list itself
// (a deliberate code change, not a data change).
export const RAG_DENIED_PATH_PREFIXES = Object.freeze([
  "60_Finanzen/",
  "00_Inbox/",
  ".obsidian/",
  ".claudian/",
  ".git/",
  ".claude/"
]);

// Deliberately separate from AI_ROUTER_OLLAMA_MODEL / AI_ROUTER_OLLAMA_BASE_URL
// (the chat/answer provider config in text-response-config.js): the
// embedding model is a distinct Ollama model, selected independently, and
// must never fall back to or overwrite the chat model configuration.
export function loadOllamaEmbeddingProviderConfig(env = process.env) {
  const model = typeof env.AI_ROUTER_OLLAMA_EMBEDDING_MODEL === "string" ? env.AI_ROUTER_OLLAMA_EMBEDDING_MODEL.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(model)) {
    throw new RagError("EMBEDDING_MODEL_NOT_AVAILABLE", "The embedding model is not configured.", {
      safeDetails: { reason: model ? "model_configuration_invalid" : "model_configuration_missing" }
    });
  }
  const baseUrlRaw = typeof env.AI_ROUTER_OLLAMA_BASE_URL === "string" ? env.AI_ROUTER_OLLAMA_BASE_URL.trim() : "";
  const baseUrl = parseOllamaLoopbackUrl(baseUrlRaw || "http://localhost:11434");
  if (!baseUrl) {
    throw new RagError("EMBEDDING_PROVIDER_UNAVAILABLE", "The embedding provider base URL is not configured.", {
      safeDetails: { reason: "base_url_configuration_invalid" }
    });
  }
  return Object.freeze({ model, baseUrl, timeoutMs: RAG_EMBEDDING_TIMEOUT_MS });
}
