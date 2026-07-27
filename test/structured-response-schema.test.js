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

test("a top-level array or non-object JSON value fails closed", () => {
  assert.throws(() => parseStructuredReport("project_status_report", "[]"), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("project_status_report", "42"), { code: "PROVIDER_RESPONSE_INVALID" });
  assert.throws(() => parseStructuredReport("project_status_report", "null"), { code: "PROVIDER_RESPONSE_INVALID" });
});
