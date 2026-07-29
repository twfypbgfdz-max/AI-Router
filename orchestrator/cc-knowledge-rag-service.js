import { assertEmbeddingModelAvailable, embedText } from "./knowledge/embedding-client.js";
import { readAllChunks, readIndexMeta } from "./knowledge/rag-index-store.js";
import { searchKnowledgeChunks } from "./knowledge/rag-search.js";
import { CC_KNOWLEDGE_INDEX_MAX_AGE_MS } from "./cc-knowledge-config.js";
import { loadOllamaEmbeddingProviderConfig } from "./knowledge/rag-config.js";

// Everything this module is allowed to do: read the already-built local
// index (chunks.jsonl / index-meta.json), check the embedding model is
// installed, embed the already-validated question, and search. It never
// opens a vault document (document-loader.js is not imported here), never
// triggers orchestrator/knowledge/rag-indexer.js, and never accepts a
// caller-supplied similarity threshold or top-k - searchKnowledgeChunks is
// always called with its own built-in defaults (RAG_DEFAULT_MIN_SIMILARITY,
// RAG_DEFAULT_TOP_K from rag-config.js), never with request-derived values.
function isIndexStale(meta, now) {
  const checkedAt = meta.lastRunAt || meta.lastFullReindexAt;
  if (!checkedAt || !Number.isFinite(Date.parse(checkedAt))) return true;
  return now.getTime() - Date.parse(checkedAt) > CC_KNOWLEDGE_INDEX_MAX_AGE_MS;
}

// Staleness is evaluated before match state and, when true, always wins as
// the reported knowledgeState - "index_stale" - even if matches were found,
// so a caller always sees a single, unambiguous signal that the underlying
// index may be outdated. results (if any) are still returned alongside it;
// staleness is a transparency flag, not a reason to withhold otherwise-valid
// matches (DEC-003: the last known-good state stays visible, but marked).
export async function retrieveKnowledge(question, {
  env = process.env,
  now = () => new Date(),
  readIndexMetaFn = readIndexMeta,
  readAllChunksFn = readAllChunks,
  assertEmbeddingModelAvailableFn = assertEmbeddingModelAvailable,
  embedTextFn = embedText,
  searchFn = searchKnowledgeChunks
} = {}) {
  let embeddingConfig;
  try {
    embeddingConfig = loadOllamaEmbeddingProviderConfig(env);
    await assertEmbeddingModelAvailableFn(embeddingConfig);
  } catch {
    return Object.freeze({ knowledgeState: "embedding_model_unavailable", results: Object.freeze([]) });
  }

  const meta = readIndexMetaFn();
  const chunks = readAllChunksFn();
  if (!meta || chunks.length === 0) {
    return Object.freeze({ knowledgeState: "index_missing", results: Object.freeze([]) });
  }
  const stale = isIndexStale(meta, now());

  let embedding;
  try {
    embedding = await embedTextFn(question, embeddingConfig);
  } catch {
    return Object.freeze({ knowledgeState: "search_failed", results: Object.freeze([]) });
  }

  let searchResult;
  try {
    searchResult = searchFn(embedding, chunks);
  } catch {
    return Object.freeze({ knowledgeState: "search_failed", results: Object.freeze([]) });
  }

  if (stale) {
    return Object.freeze({ knowledgeState: "index_stale", results: searchResult.results });
  }
  if (searchResult.results.length === 0) {
    return Object.freeze({ knowledgeState: "no_match", results: Object.freeze([]) });
  }
  return Object.freeze({ knowledgeState: "available", results: searchResult.results });
}
