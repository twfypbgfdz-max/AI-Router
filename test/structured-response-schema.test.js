import test from "node:test";
import assert from "node:assert/strict";
import { isStructuredReportIntent, parseStructuredReport } from "../orchestrator/structured-response-schema.js";

test("non-report intents are not structured and parsing returns null", () => {
  assert.equal(isStructuredReportIntent("general_question"), false);
  assert.equal(parseStructuredReport("general_question", "not json"), null);
});

test("a valid project status report parses and is deep-frozen plain data", () => {
  const payload = {
    summary: "Everything is on track.",
    keyFacts: ["Test suite is green.", "No open PRs."],
    openQuestions: ["Should we cut a release?"],
    risks: []
  };
  const parsed = parseStructuredReport("project_status_report", JSON.stringify(payload));
  assert.deepEqual(parsed, payload);
});

test("a valid git change report parses with commit entries", () => {
  const payload = {
    summary: "Two commits added Ollama support.",
    commits: [
      { ref: "abc123", description: "Add Ollama adapter." },
      { ref: "def456", description: "Wire the adapter into the service." }
    ],
    risks: ["Not yet load-tested."]
  };
  const parsed = parseStructuredReport("git_change_report", JSON.stringify(payload));
  assert.deepEqual(parsed, payload);
});

test("invalid JSON fails closed", () => {
  assert.throws(
    () => parseStructuredReport("project_status_report", "not json at all"),
    (error) => error.code === "PROVIDER_RESPONSE_INVALID" && error.safeDetails?.reason === "structured_output_invalid"
  );
});

test("extra or missing top-level keys fail closed", () => {
  assert.throws(() => parseStructuredReport("project_status_report", JSON.stringify({
    summary: "x", keyFacts: [], openQuestions: [], risks: [], extra: "not allowed"
  })), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("project_status_report", JSON.stringify({
    summary: "x", keyFacts: [], openQuestions: []
  })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("wrong field types fail closed", () => {
  assert.throws(() => parseStructuredReport("project_status_report", JSON.stringify({
    summary: 123, keyFacts: [], openQuestions: [], risks: []
  })), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("project_status_report", JSON.stringify({
    summary: "x", keyFacts: "not an array", openQuestions: [], risks: []
  })), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("project_status_report", JSON.stringify({
    summary: "x", keyFacts: [1, 2], openQuestions: [], risks: []
  })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("an empty summary string fails closed", () => {
  assert.throws(() => parseStructuredReport("project_status_report", JSON.stringify({
    summary: "   ", keyFacts: [], openQuestions: [], risks: []
  })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("malformed commit entries fail closed", () => {
  const badShapes = [
    { summary: "x", commits: "not an array", risks: [] },
    { summary: "x", commits: [{ ref: "abc" }], risks: [] },
    { summary: "x", commits: [{ ref: "abc", description: "d", extra: "nope" }], risks: [] },
    { summary: "x", commits: [{ ref: 1, description: "d" }], risks: [] }
  ];
  for (const payload of badShapes) {
    assert.throws(() => parseStructuredReport("git_change_report", JSON.stringify(payload)), { code: "PROVIDER_RESPONSE_INVALID" });
  }
});

test("a valid knowledge answer with one cited source parses", () => {
  const payload = { answer: "FELIX_SYSTEM speichert langfristiges Wissen.", citedSources: ["K1"] };
  const parsed = parseStructuredReport("knowledge_answer", JSON.stringify(payload));
  assert.deepEqual(parsed, payload);
});

test("a valid knowledge answer citing all three sources parses", () => {
  const payload = { answer: "Beleg aus drei Fundstellen.", citedSources: ["K1", "K2", "K3"] };
  const parsed = parseStructuredReport("knowledge_answer", JSON.stringify(payload));
  assert.deepEqual(parsed, payload);
});

test("a knowledge answer with an empty citedSources array is valid (context-only answer)", () => {
  const payload = { answer: "Der Branch ist aktuell dev.", citedSources: [] };
  const parsed = parseStructuredReport("knowledge_answer", JSON.stringify(payload));
  assert.deepEqual(parsed, payload);
});

test("an empty answer string fails closed", () => {
  assert.throws(() => parseStructuredReport("knowledge_answer", JSON.stringify({ answer: "   ", citedSources: [] })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("an unknown source id like K9 fails closed", () => {
  assert.throws(() => parseStructuredReport("knowledge_answer", JSON.stringify({ answer: "x", citedSources: ["K9"] })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("a duplicate source id fails closed, is never silently deduplicated", () => {
  assert.throws(() => parseStructuredReport("knowledge_answer", JSON.stringify({ answer: "x", citedSources: ["K1", "K1"] })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("more than three source ids fail closed", () => {
  assert.throws(() => parseStructuredReport("knowledge_answer", JSON.stringify({ answer: "x", citedSources: ["K1", "K2", "K3", "K1"] })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("a non-array citedSources fails closed", () => {
  assert.throws(() => parseStructuredReport("knowledge_answer", JSON.stringify({ answer: "x", citedSources: "K1" })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("a non-string entry in citedSources fails closed", () => {
  assert.throws(() => parseStructuredReport("knowledge_answer", JSON.stringify({ answer: "x", citedSources: [1] })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("a lowercase or malformed source id fails closed", () => {
  assert.throws(() => parseStructuredReport("knowledge_answer", JSON.stringify({ answer: "x", citedSources: ["k1"] })), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("knowledge_answer", JSON.stringify({ answer: "x", citedSources: ["K4"] })), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("knowledge_answer", JSON.stringify({ answer: "x", citedSources: ["K1 "] })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("an additional field on a knowledge answer fails closed", () => {
  assert.throws(() => parseStructuredReport("knowledge_answer", JSON.stringify({ answer: "x", citedSources: [], sourceDoc: "10_Apps/x.md" })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("a missing field on a knowledge answer fails closed", () => {
  assert.throws(() => parseStructuredReport("knowledge_answer", JSON.stringify({ answer: "x" })), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("knowledge_answer", JSON.stringify({ citedSources: [] })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("the model cannot smuggle sourceDoc, section or similarity through the answer schema", () => {
  assert.throws(() => parseStructuredReport("knowledge_answer", JSON.stringify({
    answer: "x", citedSources: ["K1"], sourceDoc: "10_Apps/x.md", section: "A", similarity: 0.9
  })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("a top-level array or non-object JSON value fails closed", () => {
  assert.throws(() => parseStructuredReport("project_status_report", "[]"), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("project_status_report", "42"), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("project_status_report", "null"), { code: "PROVIDER_RESPONSE_INVALID" });
});

// --- snapshot_briefing: this schema only validates the raw provider text
// (the model's JSON output) BEFORE cc-snapshot-handler.js ever sees it -
// it has no notion of a request-specific ranking and therefore cannot and
// does not check membership in ranking.items. It only checks that
// recommendedItemId is null or shaped like a real item ID (the same
// ID_PATTERN cc-snapshot-contract.js already enforces for every
// alertId/serviceId/repoId/checkId/projectId). The membership/consistency
// check against the actual ranking is exclusively the handler's job.

test("a valid snapshot_briefing answer with a real-ID-shaped recommendedItemId parses", () => {
  const payload = { text: "Der Service-Ausfall hat Prioritaet.", recommendedItemId: "svc-router" };
  assert.deepEqual(parseStructuredReport("snapshot_briefing", JSON.stringify(payload)), payload);
});

test("a valid snapshot_briefing answer with recommendedItemId null parses", () => {
  const payload = { text: "Keine offenen Punkte.", recommendedItemId: null };
  assert.deepEqual(parseStructuredReport("snapshot_briefing", JSON.stringify(payload)), payload);
});

test("a positional label like 'R1' is no longer a valid recommendedItemId shape", () => {
  assert.throws(() => parseStructuredReport("snapshot_briefing", JSON.stringify({ text: "x", recommendedItemId: "R1" })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("recommendedItemId must still match the same ID shape every ranking item ID uses (lowercase, allowed characters, max length)", () => {
  assert.throws(() => parseStructuredReport("snapshot_briefing", JSON.stringify({ text: "x", recommendedItemId: "Invalid Item!" })), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("snapshot_briefing", JSON.stringify({ text: "x", recommendedItemId: "A".repeat(97) })), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.doesNotThrow(() => parseStructuredReport("snapshot_briefing", JSON.stringify({ text: "x", recommendedItemId: "a".repeat(96) })));
});

test("this schema accepts any real-ID-shaped recommendedItemId regardless of any actual ranking - membership is validated by the handler, not here", () => {
  // "an-id-that-does-not-exist-in-any-ranking" is shape-valid and therefore
  // parses fine at this layer; cc-snapshot-handler.js is what rejects it
  // for not matching the deterministic top item.
  const payload = { text: "x", recommendedItemId: "an-id-that-does-not-exist-in-any-ranking" };
  assert.deepEqual(parseStructuredReport("snapshot_briefing", JSON.stringify(payload)), payload);
});

test("a non-string, non-null recommendedItemId fails closed", () => {
  assert.throws(() => parseStructuredReport("snapshot_briefing", JSON.stringify({ text: "x", recommendedItemId: 1 })), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("snapshot_briefing", JSON.stringify({ text: "x", recommendedItemId: ["svc-router"] })), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("an extra or missing field on a snapshot_briefing answer fails closed", () => {
  assert.throws(() => parseStructuredReport("snapshot_briefing", JSON.stringify({ text: "x", recommendedItemId: null, extra: 1 })), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("snapshot_briefing", JSON.stringify({ text: "x" })), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("snapshot_briefing", JSON.stringify({ recommendedItemId: null })), { code: "PROVIDER_RESPONSE_INVALID" });
});
