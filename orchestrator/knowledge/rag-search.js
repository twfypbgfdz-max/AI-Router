import { RAG_DEFAULT_MIN_SIMILARITY, RAG_DEFAULT_TOP_K, RAG_MAX_COMBINED_SNIPPET_CHARS, RAG_MAX_TOP_K } from "./rag-config.js";

// Pure in-memory cosine similarity - no external vector-DB dependency. At
// the small chunk counts this feature is scoped to (explicit allowlist, no
// full-vault indexing), brute-force search over all chunks is fast enough
// and avoids an unjustified new dependency.
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function freshnessOf(indexedAt, maxAgeMs, now) {
  if (!indexedAt || !Number.isFinite(Date.parse(indexedAt))) return "unknown";
  return now - Date.parse(indexedAt) > maxAgeMs ? "stale" : "fresh";
}

// Not wired into the answer pipeline yet (Commit C) - this module is a
// standalone, independently testable search function over the chunks the
// indexer already wrote.
export function searchKnowledgeChunks(queryEmbedding, chunks, {
  minSimilarity = RAG_DEFAULT_MIN_SIMILARITY,
  topK = RAG_DEFAULT_TOP_K,
  maxCombinedChars = RAG_MAX_COMBINED_SNIPPET_CHARS,
  freshnessMaxAgeMs = 24 * 60 * 60_000,
  now = Date.now()
} = {}) {
  const effectiveTopK = Math.min(Math.max(1, topK), RAG_MAX_TOP_K);
  const scored = chunks
    .map((chunk) => ({ chunk, similarity: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .filter(({ similarity }) => similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, effectiveTopK);

  if (scored.length === 0) {
    return Object.freeze({ results: Object.freeze([]), truncated: false });
  }

  const results = [];
  let combinedChars = 0;
  let truncated = false;
  for (const { chunk, similarity } of scored) {
    if (combinedChars + chunk.text.length > maxCombinedChars) {
      truncated = true;
      break;
    }
    combinedChars += chunk.text.length;
    results.push(Object.freeze({
      sourceDoc: chunk.sourceDoc,
      section: chunk.section,
      docStatus: chunk.docStatus,
      docVersion: chunk.docVersion,
      similarity,
      snippet: chunk.text,
      indexedAt: chunk.indexedAt,
      freshness: freshnessOf(chunk.indexedAt, freshnessMaxAgeMs, now)
    }));
  }

  return Object.freeze({ results: Object.freeze(results), truncated });
}
