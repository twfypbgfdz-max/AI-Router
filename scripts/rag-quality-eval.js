// Manual-only entry point: `npm run rag:quality`. Measures how well the
// EXISTING local RAG index answers a fixed question set. Strictly read-only:
// it never re-indexes, never opens a vault document, never writes anything
// outside stdout. It is not part of `npm test` because it needs a running
// Ollama and a built index; the pure scoring logic it uses is covered there
// instead (test/rag-quality-eval.test.js).
//
// Usage:
//   npm run rag:quality
//   npm run rag:quality -- --min-similarity=0.55,0.60,0.65
//   npm run rag:quality -- --top-k=3 --json
//
// Passing several thresholds runs the same questions against each of them and
// prints one comparison row per threshold. Questions are embedded once and
// reused across thresholds - the embedding does not depend on the threshold,
// and re-embedding per threshold would only add cost and jitter.
import { loadAllowlist } from "../orchestrator/knowledge/document-allowlist.js";
import { assertEmbeddingModelAvailable, embedText } from "../orchestrator/knowledge/embedding-client.js";
import { readAllChunks, readIndexMeta } from "../orchestrator/knowledge/rag-index-store.js";
import { searchKnowledgeChunks } from "../orchestrator/knowledge/rag-search.js";
import { loadQualitySet } from "../orchestrator/knowledge/rag-quality-set.js";
import { evaluateQualityCase, summarizeQualityEvaluation } from "../orchestrator/knowledge/rag-quality-eval.js";
import {
  RAG_ALLOWLIST_FILE,
  RAG_DEFAULT_MIN_SIMILARITY,
  RAG_DEFAULT_TOP_K,
  RAG_QUALITY_SET_FILE,
  loadOllamaEmbeddingProviderConfig
} from "../orchestrator/knowledge/rag-config.js";
import { RagError } from "../orchestrator/knowledge/rag-error.js";
import { RagQualityError } from "../orchestrator/knowledge/rag-quality-error.js";

function parseArgs(argv) {
  const args = { minSimilarities: [RAG_DEFAULT_MIN_SIMILARITY], topK: RAG_DEFAULT_TOP_K, json: false };
  for (const raw of argv) {
    const [flag, value] = raw.split("=");
    if (flag === "--min-similarity" && value) {
      const parsed = value.split(",").map((part) => Number(part.trim()));
      if (parsed.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
        throw new Error("--min-similarity expects comma-separated numbers between 0 and 1.");
      }
      args.minSimilarities = parsed;
    } else if (flag === "--top-k" && value) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--top-k expects a positive integer.");
      args.topK = parsed;
    } else if (flag === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unknown argument: ${raw}`);
    }
  }
  return args;
}

function shortDoc(relativePath) {
  return relativePath ? relativePath.split("/").pop().replace(/\.md$/, "") : "-";
}

function formatRate(value) {
  return value === null ? "  n/a" : `${(value * 100).toFixed(1).padStart(5)}%`;
}

function printCaseTable(caseResults) {
  console.log("");
  console.log("  ID    Verdict            Rank  Sim    Top-Treffer");
  console.log("  ----- ------------------ ----- ------ ------------------------------");
  for (const result of caseResults) {
    const sim = result.topSimilarity === null ? "  -   " : result.topSimilarity.toFixed(3);
    const rank = result.rank === null ? "  -  " : String(result.rank).padStart(3) + "  ";
    console.log(`  ${result.id.padEnd(5)} ${result.verdict.padEnd(18)} ${rank} ${sim}  ${shortDoc(result.topDoc)}`);
  }
}

function printSummary(minSimilarity, summary) {
  console.log("");
  console.log(`  Schwelle ${minSimilarity.toFixed(2)}  |  ${summary.positiveCases} positive, ${summary.negativeCases} negative Fälle`);
  console.log(`    Top-1-Trefferquote   ${formatRate(summary.top1Rate)}   (${summary.counts.hit_top1}/${summary.positiveCases})`);
  console.log(`    Top-K-Trefferquote   ${formatRate(summary.top3Rate)}   (${summary.counts.hit_top1 + summary.counts.hit_topk}/${summary.positiveCases})`);
  console.log(`    falsches Dokument    ${formatRate(summary.wrongDocRate)}   (${summary.counts.miss_wrong_doc}/${summary.positiveCases})`);
  console.log(`    gar kein Treffer     ${formatRate(summary.noMatchRate)}   (${summary.counts.miss_no_match}/${summary.positiveCases})`);
  console.log(`    Fehltreffer negativ  ${formatRate(summary.falseMatchRate)}   (${summary.counts.false_match}/${summary.negativeCases})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const embeddingConfig = loadOllamaEmbeddingProviderConfig();
  await assertEmbeddingModelAvailable(embeddingConfig);

  const allowlist = loadAllowlist(RAG_ALLOWLIST_FILE);
  const allowedDocuments = new Set(allowlist.documents.map((entry) => entry.relativePath));
  const qualitySet = loadQualitySet(RAG_QUALITY_SET_FILE, { allowedDocuments });

  const meta = readIndexMeta();
  const chunks = readAllChunks();
  if (!meta || chunks.length === 0) {
    throw new RagQualityError("QUALITY_INDEX_MISSING", "No RAG index found. Run `npm run rag:reindex` first.");
  }
  // A quality number measured against an index built by a different embedding
  // model or chunking version is not comparable to the previous run, so the
  // run identifies both rather than leaving the reader to assume.
  console.log(`Index: ${chunks.length} Chunks, Modell ${meta.embeddingModel}, Chunking-Version ${meta.chunkingVersion}, zuletzt ${meta.lastRunAt}`);
  console.log(`Fragenset: ${qualitySet.cases.length} Fälle aus ${RAG_QUALITY_SET_FILE}`);

  const embeddings = [];
  for (const testCase of qualitySet.cases) {
    embeddings.push(await embedText(testCase.question, embeddingConfig));
  }

  const runs = [];
  for (const minSimilarity of args.minSimilarities) {
    const caseResults = qualitySet.cases.map((testCase, index) => {
      const { results } = searchKnowledgeChunks(embeddings[index], chunks, {
        minSimilarity,
        topK: args.topK,
        // The real endpoint truncates the combined snippet text to keep the
        // prompt inside budget. That is an answer-side constraint; measuring
        // retrieval through it would let a long chunk hide a correct match
        // behind a truncation, so it is lifted here on purpose.
        maxCombinedChars: Number.MAX_SAFE_INTEGER
      });
      return evaluateQualityCase(testCase, results);
    });
    const summary = summarizeQualityEvaluation(caseResults);
    runs.push({ minSimilarity, topK: args.topK, summary, cases: caseResults });

    if (!args.json) {
      if (args.minSimilarities.length === 1) printCaseTable(caseResults);
      printSummary(minSimilarity, summary);
    }
  }

  if (args.json) {
    console.log(JSON.stringify({
      index: { chunkCount: chunks.length, embeddingModel: meta.embeddingModel, chunkingVersion: meta.chunkingVersion, lastRunAt: meta.lastRunAt },
      runs
    }, null, 2));
  }
  console.log("");
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  if (error instanceof RagError || error instanceof RagQualityError) {
    console.error(`RAG quality eval failed: ${error.code} - ${error.message}`);
  } else {
    console.error(`RAG quality eval failed: ${error.message}`);
  }
  process.exitCode = 1;
}
