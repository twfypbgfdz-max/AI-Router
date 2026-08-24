// Pure evaluation of retrieval results against an expected source document.
// Deliberately free of I/O: no index read, no embedding call, no file access.
// The CLI in scripts/rag-quality-eval.js supplies already-computed search
// results; everything here is a deterministic function of its arguments, so
// the whole scoring logic is unit-testable without Ollama and without an
// existing index.
//
// This module measures ONE property only: does the retrieval step surface
// the right document? It deliberately does not judge answer text - that
// would require a model call and turn a deterministic measurement into a
// non-reproducible one.

// A case with expectedDoc === null is a negative case: it asks something the
// allowlist genuinely cannot answer. Its purpose is to catch a similarity
// threshold set so low that unrelated questions still pull in a "matching"
// chunk - a failure mode that a hit-rate alone would reward rather than
// punish, because lowering the threshold always increases hits.
export const RAG_QUALITY_VERDICTS = Object.freeze({
  HIT_TOP1: "hit_top1",
  HIT_TOPK: "hit_topk",
  MISS_WRONG_DOC: "miss_wrong_doc",
  MISS_NO_MATCH: "miss_no_match",
  CORRECT_NO_MATCH: "correct_no_match",
  FALSE_MATCH: "false_match"
});

function positiveVerdict(expectedDoc, results) {
  if (results.length === 0) return RAG_QUALITY_VERDICTS.MISS_NO_MATCH;
  if (results[0].sourceDoc === expectedDoc) return RAG_QUALITY_VERDICTS.HIT_TOP1;
  if (results.some((result) => result.sourceDoc === expectedDoc)) return RAG_QUALITY_VERDICTS.HIT_TOPK;
  return RAG_QUALITY_VERDICTS.MISS_WRONG_DOC;
}

// rank is 1-based and only defined when the expected document was found at
// all; null otherwise. topSimilarity is reported even for a wrong-document
// result, because a confidently wrong match and a barely-above-threshold
// wrong match are different problems.
export function evaluateQualityCase(testCase, results) {
  const list = Array.isArray(results) ? results : [];
  const expectedDoc = testCase.expectedDoc;

  if (expectedDoc === null) {
    return Object.freeze({
      id: testCase.id,
      expectedDoc: null,
      verdict: list.length === 0 ? RAG_QUALITY_VERDICTS.CORRECT_NO_MATCH : RAG_QUALITY_VERDICTS.FALSE_MATCH,
      rank: null,
      topDoc: list[0]?.sourceDoc ?? null,
      topSimilarity: list[0]?.similarity ?? null,
      resultCount: list.length
    });
  }

  const foundIndex = list.findIndex((result) => result.sourceDoc === expectedDoc);
  return Object.freeze({
    id: testCase.id,
    expectedDoc,
    verdict: positiveVerdict(expectedDoc, list),
    rank: foundIndex === -1 ? null : foundIndex + 1,
    topDoc: list[0]?.sourceDoc ?? null,
    topSimilarity: list[0]?.similarity ?? null,
    resultCount: list.length
  });
}

// Measures both stages of the production search contract. rankedResults are
// the final diversified Top-K before the context budget is applied; results
// are the snippets that are actually packed into the LLM prompt.
export function evaluateQualitySearchCase(testCase, searchResult) {
  const packedResults = Array.isArray(searchResult?.results) ? searchResult.results : [];
  const retrievalResults = Array.isArray(searchResult?.rankedResults)
    ? searchResult.rankedResults
    : packedResults;
  return Object.freeze({
    retrieval: evaluateQualityCase(testCase, retrievalResults),
    packed: evaluateQualityCase(testCase, packedResults),
    llmSources: Object.freeze(packedResults.map((result) => Object.freeze({
      sourceDoc: result.sourceDoc,
      section: result.section ?? null,
      similarity: result.similarity ?? null,
      snippetChars: typeof result.snippet === "string" ? result.snippet.length : 0
    })))
  });
}

function rate(part, total) {
  return total === 0 ? null : Number((part / total).toFixed(4));
}

// Positive and negative cases are counted and rated separately on purpose.
// A single blended "accuracy" over both would let a threshold change trade
// one against the other invisibly - exactly the trade-off this eval exists
// to make visible.
export function summarizeQualityEvaluation(caseResults) {
  const counts = Object.fromEntries(Object.values(RAG_QUALITY_VERDICTS).map((verdict) => [verdict, 0]));
  for (const result of caseResults) {
    if (result.verdict in counts) counts[result.verdict] += 1;
  }

  const positives = counts.hit_top1 + counts.hit_topk + counts.miss_wrong_doc + counts.miss_no_match;
  const negatives = counts.correct_no_match + counts.false_match;

  return Object.freeze({
    total: caseResults.length,
    positiveCases: positives,
    negativeCases: negatives,
    counts: Object.freeze(counts),
    top1Rate: rate(counts.hit_top1, positives),
    top3Rate: rate(counts.hit_top1 + counts.hit_topk, positives),
    wrongDocRate: rate(counts.miss_wrong_doc, positives),
    noMatchRate: rate(counts.miss_no_match, positives),
    falseMatchRate: rate(counts.false_match, negatives)
  });
}
