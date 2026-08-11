import test from "node:test";
import assert from "node:assert/strict";
import { evaluateQualityCase, summarizeQualityEvaluation } from "../orchestrator/knowledge/rag-quality-eval.js";
import { loadQualitySet } from "../orchestrator/knowledge/rag-quality-set.js";
import { RagQualityError } from "../orchestrator/knowledge/rag-quality-error.js";
import { loadAllowlist } from "../orchestrator/knowledge/document-allowlist.js";
import { RAG_ALLOWLIST_FILE } from "../orchestrator/knowledge/rag-config.js";

function result(sourceDoc, similarity = 0.8) {
  return { sourceDoc, section: null, docStatus: null, docVersion: null, similarity, snippet: "t", indexedAt: null, freshness: "fresh" };
}

function positiveCase(expectedDoc = "a.md") {
  return { id: "Q1", question: "f?", expectedDoc, note: null };
}

function negativeCase() {
  return { id: "N1", question: "f?", expectedDoc: null, note: null };
}

// --- evaluateQualityCase -----------------------------------------------

test("expected document at position 1 counts as a top-1 hit", () => {
  const evaluated = evaluateQualityCase(positiveCase(), [result("a.md"), result("b.md")]);
  assert.equal(evaluated.verdict, "hit_top1");
  assert.equal(evaluated.rank, 1);
});

test("expected document further down counts as a top-k hit and reports its rank", () => {
  const evaluated = evaluateQualityCase(positiveCase(), [result("b.md"), result("c.md"), result("a.md")]);
  assert.equal(evaluated.verdict, "hit_topk");
  assert.equal(evaluated.rank, 3);
});

test("results without the expected document are a wrong-document miss, not a no-match", () => {
  const evaluated = evaluateQualityCase(positiveCase(), [result("b.md")]);
  assert.equal(evaluated.verdict, "miss_wrong_doc");
  assert.equal(evaluated.rank, null);
  assert.equal(evaluated.topDoc, "b.md");
});

test("an empty result for a positive case is a no-match miss", () => {
  const evaluated = evaluateQualityCase(positiveCase(), []);
  assert.equal(evaluated.verdict, "miss_no_match");
  assert.equal(evaluated.topSimilarity, null);
});

test("a negative case with no results is correct", () => {
  assert.equal(evaluateQualityCase(negativeCase(), []).verdict, "correct_no_match");
});

test("a negative case that still matches something is a false match", () => {
  const evaluated = evaluateQualityCase(negativeCase(), [result("a.md", 0.61)]);
  assert.equal(evaluated.verdict, "false_match");
  assert.equal(evaluated.topSimilarity, 0.61);
});

test("a missing result list is treated as no results, never as a crash", () => {
  assert.equal(evaluateQualityCase(positiveCase(), undefined).verdict, "miss_no_match");
});

// --- summarizeQualityEvaluation ----------------------------------------

test("positive and negative cases are counted and rated separately", () => {
  const summary = summarizeQualityEvaluation([
    evaluateQualityCase(positiveCase(), [result("a.md")]),
    evaluateQualityCase(positiveCase(), [result("b.md"), result("a.md")]),
    evaluateQualityCase(positiveCase(), [result("b.md")]),
    evaluateQualityCase(positiveCase(), []),
    evaluateQualityCase(negativeCase(), []),
    evaluateQualityCase(negativeCase(), [result("a.md")])
  ]);
  assert.equal(summary.total, 6);
  assert.equal(summary.positiveCases, 4);
  assert.equal(summary.negativeCases, 2);
  assert.equal(summary.top1Rate, 0.25);
  assert.equal(summary.top3Rate, 0.5);
  assert.equal(summary.wrongDocRate, 0.25);
  assert.equal(summary.noMatchRate, 0.25);
  assert.equal(summary.falseMatchRate, 0.5);
});

test("rates are null rather than zero when a category has no cases at all", () => {
  const summary = summarizeQualityEvaluation([evaluateQualityCase(positiveCase(), [result("a.md")])]);
  assert.equal(summary.negativeCases, 0);
  assert.equal(summary.falseMatchRate, null);
});

test("an empty evaluation reports no rates instead of dividing by zero", () => {
  const summary = summarizeQualityEvaluation([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.top1Rate, null);
});

// --- loadQualitySet -----------------------------------------------------

function loadFrom(payload, options = {}) {
  return loadQualitySet("quality-set.json", {
    readFileSync: () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    ...options
  });
}

test("loads a valid set and freezes its cases", () => {
  const set = loadFrom({ schemaVersion: "1.0", cases: [{ id: "Q1", question: "Was gilt?", expectedDoc: "a.md" }, { id: "N1", question: "Wetter?", expectedDoc: null }] });
  assert.equal(set.cases.length, 2);
  assert.equal(set.cases[1].expectedDoc, null);
  assert.ok(Object.isFrozen(set.cases[0]));
});

test("rejects an unsupported schema version", () => {
  assert.throws(() => loadFrom({ schemaVersion: "2.0", cases: [] }), (error) => error instanceof RagQualityError && error.code === "QUALITY_SET_INVALID");
});

test("rejects a duplicate case id so two runs stay comparable", () => {
  assert.throws(() => loadFrom({ schemaVersion: "1.0", cases: [{ id: "Q1", question: "a?", expectedDoc: null }, { id: "Q1", question: "b?", expectedDoc: null }] }), /case_id_duplicate/);
});

test("rejects a multi-line question, matching the endpoint's single-line rule", () => {
  assert.throws(() => loadFrom({ schemaVersion: "1.0", cases: [{ id: "Q1", question: "a\nb", expectedDoc: null }] }), /question_not_single_line/);
});

test("rejects a question longer than the endpoint would accept", () => {
  assert.throws(() => loadFrom({ schemaVersion: "1.0", cases: [{ id: "Q1", question: "x".repeat(501), expectedDoc: null }] }), /question_too_long/);
});

test("an omitted expectedDoc is rejected - only an explicit null marks a negative case", () => {
  assert.throws(() => loadFrom({ schemaVersion: "1.0", cases: [{ id: "Q1", question: "a?" }] }), /expected_doc_invalid/);
});

test("rejects an expected document that is not in the allowlist", () => {
  assert.throws(
    () => loadFrom({ schemaVersion: "1.0", cases: [{ id: "Q1", question: "a?", expectedDoc: "gone.md" }] }, { allowedDocuments: new Set(["a.md"]) }),
    /expected_doc_not_allowlisted/
  );
});

test("a negative case is not checked against the allowlist", () => {
  const set = loadFrom({ schemaVersion: "1.0", cases: [{ id: "N1", question: "a?", expectedDoc: null }] }, { allowedDocuments: new Set(["a.md"]) });
  assert.equal(set.cases.length, 1);
});

test("rejects an empty case list rather than reporting a vacuous 100 percent", () => {
  assert.throws(() => loadFrom({ schemaVersion: "1.0", cases: [] }), /cases_empty/);
});

test("rejects a file that is not valid JSON", () => {
  assert.throws(() => loadFrom("{ not json"), /not_valid_json/);
});

test("an unreadable file fails loudly instead of silently measuring nothing", () => {
  assert.throws(
    () => loadQualitySet("missing.json", { readFileSync: () => { const error = new Error("nope"); error.code = "ENOENT"; throw error; } }),
    /file_unreadable/
  );
});

// --- the real, committed question set ----------------------------------

test("the committed question set loads and contains both positive and negative cases", () => {
  const set = loadQualitySet();
  assert.ok(set.cases.length >= 10);
  assert.ok(set.cases.some((testCase) => testCase.expectedDoc === null));
  assert.ok(set.cases.some((testCase) => testCase.expectedDoc !== null));
});

// Guards the quiet drift this eval is most likely to suffer: someone removes
// a document from the allowlist, and the next quality run reports a
// retrieval regression that is really an unanswerable question. Runs offline
// - no index, no Ollama - so it fails in `npm test`, not only in a manual run.
test("every expected document of the committed set is still in the committed allowlist", () => {
  const allowedDocuments = new Set(loadAllowlist(RAG_ALLOWLIST_FILE).documents.map((entry) => entry.relativePath));
  assert.doesNotThrow(() => loadQualitySet(undefined, { allowedDocuments }));
});
