import { RAG_DEFAULT_MIN_SIMILARITY, RAG_DEFAULT_TOP_K, RAG_MAX_COMBINED_SNIPPET_CHARS, RAG_MAX_TOP_K } from "./rag-config.js";

const RAG_DIVERSITY_SENTENCE_MAX_CHARS = 96;

const QUERY_STOP_WORDS = new Set([
  "als", "auf", "aus", "bei", "bereits", "das", "dazu", "dem", "den", "der", "des", "die", "ein", "eine",
  "einer", "eines", "einem", "einen", "fur", "hat", "haben", "heute", "im", "in", "ist", "laut", "mein",
  "mit", "nach", "ob", "oder", "sich", "sind", "steht", "und", "vom", "von", "was", "welche", "welcher",
  "welches", "welchem", "wie", "zu", "zur"
]);

function normalizeWords(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/\bdec-0*(\d+)\b/g, "dec$1");
}

function stemWord(word) {
  if (word.length > 6 && word.endsWith("en")) return word.slice(0, -2);
  if (word.length > 5 && word.endsWith("e")) return word.slice(0, -1);
  return word;
}

function wordsOf(value) {
  return (normalizeWords(value).match(/[a-z0-9]+/g) || []).map(stemWord);
}

function queryTermsOf(queryText) {
  return new Set(wordsOf(queryText).filter((word) => (
    word.length > 1 && !/^\d+$/.test(word) && !QUERY_STOP_WORDS.has(word)
  )));
}

function matchingQueryTermCount(sentence, queryTerms) {
  const sentenceWords = new Set(wordsOf(sentence));
  let matches = 0;
  for (const term of queryTerms) {
    if (sentenceWords.has(term)) matches += 1;
  }
  return matches;
}

function nextNonWhitespaceIndex(text, from) {
  let index = from;
  while (index < text.length && /\s/u.test(text[index])) index += 1;
  return index;
}

function isDatePeriod(text, index, sentenceStart) {
  if (/\d/u.test(text[index - 1] || "") && /\d/u.test(text[index + 1] || "")) return true;
  const before = text.slice(sentenceStart, index + 1);
  const dateAtEnd = /\b(?:\d{1,2}\.){1,2}\d{0,4}\.$/u.test(before);
  if (!dateAtEnd) return false;
  const nextIndex = nextNonWhitespaceIndex(text, index + 1);
  return nextIndex < text.length && /\p{Ll}/u.test(text[nextIndex]);
}

function sentenceBoundaryEnd(text, index, sentenceStart, insideCode) {
  const punctuation = text[index];
  if (insideCode || !".!?".includes(punctuation)) return null;
  if (punctuation === "." && isDatePeriod(text, index, sentenceStart)) return null;

  let end = index + 1;
  while (end < text.length && "*_`])}".includes(text[end])) end += 1;
  return end;
}

function hasEvenMarkerCount(text, marker) {
  return text.split(marker).length % 2 === 1;
}

function hasBalancedDelimiters(text) {
  let round = 0;
  let square = 0;
  for (const character of text) {
    if (character === "(") round += 1;
    if (character === ")") round -= 1;
    if (character === "[") square += 1;
    if (character === "]") square -= 1;
    if (round < 0 || square < 0) return false;
  }
  return round === 0 && square === 0;
}

function isCompleteSafeSentence(sentence) {
  const trimmed = sentence.trim();
  if (!trimmed || !/[.!?](?:[*_`\])}]*)$/u.test(trimmed)) return false;
  if (trimmed.includes("```")) return false;
  if (!hasEvenMarkerCount(trimmed, "`") || !hasEvenMarkerCount(trimmed, "**") || !hasEvenMarkerCount(trimmed, "__")) return false;
  if (!hasBalancedDelimiters(trimmed)) return false;

  const visibleStart = trimmed.replace(/^(?:[-+>#]\s*|\*\s+)*(?:\*\*|__|`)?/u, "");
  if (!/^[\p{Lu}\d]/u.test(visibleStart)) return false;

  const lexicalWords = wordsOf(trimmed).filter((word) => !["nein", "nicht", "kein", "keine", "keiner"].includes(word));
  return lexicalWords.length >= 2;
}

function completeSentencesOf(text) {
  const sentences = [];
  let sentenceStart = 0;
  let insideCode = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "`") {
      let runLength = 1;
      while (text[index + runLength] === "`") runLength += 1;
      if (runLength === 1) insideCode = !insideCode;
      index += runLength - 1;
      continue;
    }
    const end = sentenceBoundaryEnd(text, index, sentenceStart, insideCode);
    if (end === null) continue;
    const sentence = text.slice(sentenceStart, end).trim();
    if (isCompleteSafeSentence(sentence)) sentences.push(sentence);
    sentenceStart = nextNonWhitespaceIndex(text, end);
    index = sentenceStart - 1;
  }
  return sentences;
}

function bestSentenceScore(text, queryTerms) {
  let best = 0;
  for (const sentence of completeSentencesOf(text)) {
    best = Math.max(best, matchingQueryTermCount(sentence, queryTerms));
  }
  return best;
}

function bestDiversitySentence(scored, excludedFrom, queryText, existingResults, remainingChars) {
  if (!queryText || remainingChars <= 0) return null;
  const queryTerms = queryTermsOf(queryText);
  if (queryTerms.size === 0) return null;

  let existingBest = 0;
  for (const result of existingResults) {
    existingBest = Math.max(existingBest, bestSentenceScore(result.snippet, queryTerms));
  }

  const sentenceLimit = Math.min(RAG_DIVERSITY_SENTENCE_MAX_CHARS, remainingChars);
  let best = null;
  for (let rank = excludedFrom; rank < scored.length; rank += 1) {
    for (const sentence of completeSentencesOf(scored[rank].chunk.text)) {
      if (sentence.length > sentenceLimit) continue;
      const score = matchingQueryTermCount(sentence, queryTerms);
      if (score <= existingBest || (best && score <= best.score)) continue;
      best = { ...scored[rank], sentence, score, rank };
    }
  }
  return best;
}

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
  queryText = "",
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
  let excludedFrom = scored.length;
  for (let rank = 0; rank < scored.length; rank += 1) {
    const { chunk, similarity } = scored[rank];
    if (combinedChars + chunk.text.length > maxCombinedChars) {
      truncated = true;
      excludedFrom = rank;
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

  const diversity = bestDiversitySentence(
    scored,
    excludedFrom,
    queryText,
    results,
    maxCombinedChars - combinedChars
  );
  if (diversity) {
    combinedChars += diversity.sentence.length;
    results.push(Object.freeze({
      sourceDoc: diversity.chunk.sourceDoc,
      section: diversity.chunk.section,
      docStatus: diversity.chunk.docStatus,
      docVersion: diversity.chunk.docVersion,
      similarity: diversity.similarity,
      snippet: diversity.sentence,
      indexedAt: diversity.chunk.indexedAt,
      freshness: freshnessOf(diversity.chunk.indexedAt, freshnessMaxAgeMs, now)
    }));
  }

  return Object.freeze({ results: Object.freeze(results), truncated });
}
