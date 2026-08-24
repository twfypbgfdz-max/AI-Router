import {
  RAG_CANDIDATE_POOL_MULTIPLIER,
  RAG_DEFAULT_MIN_SIMILARITY,
  RAG_DEFAULT_TOP_K,
  RAG_MAX_COMBINED_SNIPPET_CHARS,
  RAG_MAX_TOP_K,
  RAG_MIN_PACKED_CHARS_PER_SOURCE
} from "./rag-config.js";

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

// Keep the strongest hit first. Then prefer the strongest not-yet-selected
// document from the larger internal pool before filling any remaining slots
// with duplicate-document chunks in their original similarity order.
function diversifyCandidates(candidates, limit) {
  const selected = [];
  const selectedRanks = new Set();
  const selectedDocuments = new Set();

  for (const candidate of candidates) {
    if (selectedDocuments.has(candidate.chunk.sourceDoc)) continue;
    selected.push(candidate);
    selectedRanks.add(candidate.rank);
    selectedDocuments.add(candidate.chunk.sourceDoc);
    if (selected.length === limit) return selected;
  }

  for (const candidate of candidates) {
    if (selectedRanks.has(candidate.rank)) continue;
    selected.push(candidate);
    if (selected.length === limit) break;
  }
  return selected;
}

function resultFromCandidate(candidate, freshnessMaxAgeMs, now) {
  const { chunk, similarity } = candidate;
  return Object.freeze({
    sourceDoc: chunk.sourceDoc,
    section: chunk.section,
    docStatus: chunk.docStatus,
    docVersion: chunk.docVersion,
    similarity,
    snippet: chunk.text,
    indexedAt: chunk.indexedAt,
    freshness: freshnessOf(chunk.indexedAt, freshnessMaxAgeMs, now)
  });
}

function boundedPrefix(text, maxChars) {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  if (maxChars === 1) return "…";

  const contentLimit = maxChars - 1;
  const raw = text.slice(0, contentLimit);
  const minimumBoundary = Math.floor(contentLimit * 0.6);
  const newlineBoundary = raw.lastIndexOf("\n");
  const whitespaceBoundary = raw.search(/\s+\S*$/u);
  const boundary = newlineBoundary >= minimumBoundary
    ? newlineBoundary
    : whitespaceBoundary >= minimumBoundary ? whitespaceBoundary : contentLimit;
  return `${raw.slice(0, boundary).trimEnd()}…`;
}

// Reserve a small deterministic share for every later source before the
// current source is packed. Short early snippets leave their unused budget to
// later sources; a long first snippet can no longer consume all 2,000 chars.
function packRankedResults(rankedResults, maxCombinedChars) {
  const finiteBudget = Number.isFinite(maxCombinedChars)
    ? Math.max(0, Math.floor(maxCombinedChars))
    : Number.MAX_SAFE_INTEGER;
  const usableCount = Math.min(rankedResults.length, finiteBudget);
  const results = [];
  let remaining = finiteBudget;
  let truncated = usableCount < rankedResults.length;

  for (let index = 0; index < usableCount; index += 1) {
    const ranked = rankedResults[index];
    const remainingSources = usableCount - index;
    const fairShare = Math.floor(remaining / remainingSources);
    const reservedPerLaterSource = Math.min(RAG_MIN_PACKED_CHARS_PER_SOURCE, fairShare);
    const allowance = remaining - (remainingSources - 1) * reservedPerLaterSource;
    const snippet = boundedPrefix(ranked.snippet, allowance);
    if (snippet.length < ranked.snippet.length) truncated = true;
    remaining -= snippet.length;
    results.push(Object.freeze({ ...ranked, snippet }));
  }

  return Object.freeze({ results: Object.freeze(results), truncated });
}

export function searchKnowledgeChunks(queryEmbedding, chunks, {
  minSimilarity = RAG_DEFAULT_MIN_SIMILARITY,
  topK = RAG_DEFAULT_TOP_K,
  maxCombinedChars = RAG_MAX_COMBINED_SNIPPET_CHARS,
  freshnessMaxAgeMs = 24 * 60 * 60_000,
  now = Date.now()
} = {}) {
  const effectiveTopK = Math.min(Math.max(1, topK), RAG_MAX_TOP_K);
  const candidatePoolSize = effectiveTopK * RAG_CANDIDATE_POOL_MULTIPLIER;
  const candidates = chunks
    .map((chunk, rank) => ({ chunk, rank, similarity: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .filter(({ similarity }) => similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity || a.rank - b.rank)
    .slice(0, candidatePoolSize);

  if (candidates.length === 0) {
    return Object.freeze({
      results: Object.freeze([]),
      rankedResults: Object.freeze([]),
      truncated: false
    });
  }

  const diversified = diversifyCandidates(candidates, effectiveTopK);
  const rankedResults = Object.freeze(
    diversified.map((candidate) => resultFromCandidate(candidate, freshnessMaxAgeMs, now))
  );
  const packed = packRankedResults(rankedResults, maxCombinedChars);
  return Object.freeze({
    results: packed.results,
    rankedResults,
    truncated: packed.truncated
  });
}
