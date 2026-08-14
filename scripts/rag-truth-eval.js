// Explicit, read-only local-model truth evaluation.
//
// This runner intentionally does not recreate the Knowledge/Jarvis pipeline.
// It validates questions with the production generic contract, retrieves once
// through the production RAG service, then invokes createKnowledgeService for
// every sample. That reuses the production authority classification, prompt,
// forced-local provider, structured response parsing and source validation.
// Only HTTP transport and route authentication are omitted.
//
// One retrieval snapshot is reused for all samples of a case: `--samples=3`
// measures model variance, not a mixture of model and retrieval variance.
// A fresh service instance per sample mirrors the existing parity runner and
// prevents the production route's one-request-per-minute limiter from turning
// a manual acceptance run into an artificial wait.
import { normalizeKnowledgeRequest } from "../orchestrator/knowledge-contract.js";
import {
  KNOWLEDGE_ABSOLUTE_TIMEOUT_MS,
  KNOWLEDGE_MAX_CONCURRENT_REQUESTS,
  KNOWLEDGE_MAX_REQUESTS_PER_WINDOW,
  KNOWLEDGE_SCHEMA_VERSION
} from "../orchestrator/knowledge-config.js";
import { retrieveKnowledge } from "../orchestrator/knowledge-answer-rag-service.js";
import { createKnowledgeService } from "../orchestrator/knowledge-service.js";
import { loadAllowlist } from "../orchestrator/knowledge/document-allowlist.js";
import { readIndexMeta } from "../orchestrator/knowledge/rag-index-store.js";
import { RAG_ALLOWLIST_FILE, RAG_TRUTH_SET_FILE } from "../orchestrator/knowledge/rag-config.js";
import { evaluateTruthSample, summarizeTruthCase, summarizeTruthEvaluation } from "../orchestrator/knowledge/rag-truth-eval.js";
import { RagTruthError } from "../orchestrator/knowledge/rag-truth-error.js";
import { loadTruthSet } from "../orchestrator/knowledge/rag-truth-set.js";

function parseArgs(argv) {
  const args = { samples: 1, json: false, verbose: false };
  for (const raw of argv) {
    const [flag, value] = raw.split("=");
    if (flag === "--samples" && value) {
      const parsed = Number(value);
      if (parsed !== 1 && parsed !== 3) throw new Error("--samples expects exactly 1 or 3.");
      args.samples = parsed;
    } else if (flag === "--json") args.json = true;
    else if (flag === "--verbose") args.verbose = true;
    else throw new Error(`Unknown argument: ${raw}`);
  }
  return args;
}

function shortDoc(relativePath) {
  return relativePath ? relativePath.split("/").pop().replace(/\.md$/u, "") : "-";
}

function compactAnswer(answer, maxLength = 280) {
  const compact = String(answer ?? "(keine Antwort)").replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function createProductionAnswerer(retrieval) {
  return createKnowledgeService({
    env: process.env,
    retrieveKnowledgeFn: async () => retrieval,
    maxConcurrentRequests: KNOWLEDGE_MAX_CONCURRENT_REQUESTS,
    maxRequestsPerWindow: KNOWLEDGE_MAX_REQUESTS_PER_WINDOW,
    totalTimeoutMs: KNOWLEDGE_ABSOLUTE_TIMEOUT_MS,
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    requestIdPrefix: "rag-truth"
  });
}

function printCase(entry, { verbose }) {
  if (entry.summary.verdict === "not_evaluable") {
    console.log(`  ${entry.id}  NOT EVALUABLE  ${entry.reason}`);
    return;
  }
  console.log(`  ${entry.id}  ${entry.summary.verdict.toUpperCase().padEnd(8)}  ${entry.summary.passCount}/${entry.summary.sampleCount}`);
  for (const [index, sample] of entry.samples.entries()) {
    const sourceNames = sample.citedEvidence.map((source) => shortDoc(source.sourceDoc)).join(", ") || "keine";
    const failed = sample.failedAssertions.length ? `; fehlend: ${sample.failedAssertions.join(", ")}` : "";
    console.log(`        Sample ${index + 1}: ${sample.verdict.toUpperCase()}; Quellen: ${sourceNames}${failed}`);
    if (verbose || sample.verdict !== "pass") console.log(`        Antwort: ${compactAnswer(sample.payload?.answer)}`);
  }
}

async function evaluateCase(testCase, sampleCount) {
  const normalized = normalizeKnowledgeRequest({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, question: testCase.question });
  const retrieval = await retrieveKnowledge(normalized.question);
  const indexState = retrieval.indexVerification?.state ?? "unavailable";
  if (indexState !== "content_current") {
    return Object.freeze({
      id: testCase.id,
      question: testCase.question,
      retrieval,
      samples: Object.freeze([]),
      reason: `index_state=${indexState}; knowledge_state=${retrieval.knowledgeState}`,
      summary: Object.freeze({ sampleCount: 0, passCount: 0, verdict: "not_evaluable" })
    });
  }

  const samples = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const answerKnowledgeQuestion = createProductionAnswerer(retrieval);
    const { payload } = await answerKnowledgeQuestion({ question: normalized.question });
    samples.push(evaluateTruthSample(testCase, { payload, retrieval }));
  }
  return Object.freeze({
    id: testCase.id,
    question: testCase.question,
    retrieval,
    samples: Object.freeze(samples),
    reason: null,
    summary: summarizeTruthCase(samples)
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allowlist = loadAllowlist(RAG_ALLOWLIST_FILE);
  const allowedDocuments = new Set(allowlist.documents.map((entry) => entry.relativePath));
  const truthSet = loadTruthSet(RAG_TRUTH_SET_FILE, { allowedDocuments });
  const meta = readIndexMeta();
  const indexedChunkCount = meta?.fingerprint?.chunkCount ?? null;

  if (!args.json) {
    console.log(`Truth-Set: ${truthSet.cases.length} Fälle aus ${RAG_TRUTH_SET_FILE}`);
    console.log(`Modus: ${args.samples === 1 ? "Diagnose (1 Sample)" : "Abnahme (3 Samples, 3/3 erforderlich)"}`);
    console.log(`Index: ${indexedChunkCount ?? "nicht vorhanden"} Chunks, Modell ${meta?.embeddingModel ?? "unbekannt"}, zuletzt ${meta?.lastRunAt ?? "unbekannt"}`);
    console.log("");
  }

  const cases = [];
  for (const testCase of truthSet.cases) {
    const evaluated = await evaluateCase(testCase, args.samples);
    cases.push(evaluated);
    if (!args.json) printCase(evaluated, args);
  }
  const summary = summarizeTruthEvaluation(cases);

  if (args.json) {
    console.log(JSON.stringify({
      mode: args.samples === 1 ? "diagnostic" : "acceptance",
      samplesPerCase: args.samples,
      index: meta ? { chunkCount: indexedChunkCount, embeddingModel: meta.embeddingModel, chunkingVersion: meta.chunkingVersion, lastRunAt: meta.lastRunAt } : null,
      summary,
      cases
    }, null, 2));
  } else {
    console.log("");
    console.log(`Ergebnis: ${summary.green ? "GRÜN" : "NICHT GRÜN"}`);
    console.log(`  pass=${summary.counts.pass}, unstable=${summary.counts.unstable}, fail=${summary.counts.fail}, not_evaluable=${summary.counts.not_evaluable}`);
    if (args.samples === 1) console.log("  Hinweis: Dies ist nur die Diagnose; formale Abnahme erfordert --samples=3.");
  }
  return summary.green ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof RagTruthError) console.error(`RAG truth eval failed: ${error.code} - ${error.message}`);
  else console.error(`RAG truth eval failed: ${error.message}`);
  process.exitCode = 1;
}
