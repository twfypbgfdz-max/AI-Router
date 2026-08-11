import path from "node:path";
import { DATA_DIR, REPOSITORY_ROOT } from "../config.js";
import { parseOllamaLoopbackUrl } from "../ollama-loopback.js";
import { RagError } from "./rag-error.js";

// Independent schema/version counter for the RAG index - never compared to
// the router API, recommendation or cc-summary schema versions (same
// principle as cc-summary-config.js: separate contracts, separate counters).
export const RAG_INDEX_SCHEMA_VERSION = "1.0";

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

export const RAG_MAX_ALLOWLIST_ENTRIES = 100;
export const RAG_MAX_DOCUMENT_BYTES = 200_000;
export const RAG_MAX_CHUNK_CHARS = 2_000;
export const RAG_TARGET_CHUNK_CHARS = 1_200;
export const RAG_MAX_CHUNKS_PER_DOCUMENT = 200;

// Calibrated against a 15-question German quality set on the real
// FELIX_SYSTEM allowlist (6 documents, 109 chunks) after the chunking
// version 2 title/section prefix was introduced. Compared 0.65/0.62/0.60:
// 0.60 answered 10/15 questions (up from 4/15 at 0.65) with zero observed
// wrong-document or off-topic top-3 results at any of the three tested
// values - the earlier cross-document confusion (Command-Center chunk
// outranking AI-Router for an AI-Router question) was fixed by the prefix
// itself, not by this threshold change. Still a starting point for a small,
// hand-picked corpus - revisit once the allowlist grows.
export const RAG_DEFAULT_MIN_SIMILARITY = 0.60;
export const RAG_DEFAULT_TOP_K = 3;
export const RAG_MAX_TOP_K = 5;
export const RAG_MAX_COMBINED_SNIPPET_CHARS = 2_000;

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
