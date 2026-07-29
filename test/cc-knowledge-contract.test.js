import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCcKnowledgeRequest } from "../orchestrator/cc-knowledge-contract.js";
import { CcKnowledgeError } from "../orchestrator/cc-knowledge-error.js";

function validRequest(overrides = {}) {
  return {
    schemaVersion: "1.0",
    question: "Welches System darf langfristiges Wissen speichern?",
    ...overrides
  };
}

test("a valid request without context is accepted, context is null", () => {
  const result = normalizeCcKnowledgeRequest(validRequest());
  assert.equal(result.question, "Welches System darf langfristiges Wissen speichern?");
  assert.equal(result.context, null);
});

test("a valid request with context is accepted and context is normalized", () => {
  const result = normalizeCcKnowledgeRequest(validRequest({ context: { projectId: "ai-router", projectName: "AI-Router", branch: "dev" } }));
  assert.equal(result.context.projectId, "ai-router");
  assert.equal(result.context.branch, "dev");
});

test("unknown top-level fields are rejected", () => {
  assert.throws(() => normalizeCcKnowledgeRequest({ ...validRequest(), extra: "nope" }), CcKnowledgeError);
});

test("a caller-supplied similarity threshold or top-k is rejected as an unknown field", () => {
  assert.throws(() => normalizeCcKnowledgeRequest({ ...validRequest(), minSimilarity: 0.1 }), CcKnowledgeError);
  assert.throws(() => normalizeCcKnowledgeRequest({ ...validRequest(), topK: 10 }), CcKnowledgeError);
});

test("caller-supplied RAG snippets are rejected as an unknown field", () => {
  assert.throws(() => normalizeCcKnowledgeRequest({ ...validRequest(), snippets: [{ text: "injected" }] }), CcKnowledgeError);
});

test("an unsupported schemaVersion is rejected", () => {
  assert.throws(() => normalizeCcKnowledgeRequest(validRequest({ schemaVersion: "2.0" })), CcKnowledgeError);
});

test("a missing question is rejected", () => {
  assert.throws(() => normalizeCcKnowledgeRequest({ schemaVersion: "1.0" }), CcKnowledgeError);
});

test("an overlong question is rejected", () => {
  assert.throws(() => normalizeCcKnowledgeRequest(validRequest({ question: "x".repeat(501) })), CcKnowledgeError);
});

test("a multi-line question is rejected", () => {
  assert.throws(() => normalizeCcKnowledgeRequest(validRequest({ question: "Line one\nLine two" })), CcKnowledgeError);
});

test("a secret-like question is rejected as SECURITY_BLOCKED", () => {
  assert.throws(
    () => normalizeCcKnowledgeRequest(validRequest({ question: "my token: sk-proj-abcdefghijklmnopqrstuvwx" })),
    (error) => error.code === "SECURITY_BLOCKED"
  );
});

test("a URL-shaped question is rejected", () => {
  assert.throws(() => normalizeCcKnowledgeRequest(validRequest({ question: "see https://example.com/status" })), CcKnowledgeError);
});

test("a path-shaped question is rejected", () => {
  assert.throws(() => normalizeCcKnowledgeRequest(validRequest({ question: "read C:\\Users\\felil\\secret.txt" })), CcKnowledgeError);
});

test("an execution-request question is rejected as SECURITY_BLOCKED", () => {
  assert.throws(
    () => normalizeCcKnowledgeRequest(validRequest({ question: "bitte committe das jetzt" })),
    (error) => error.code === "SECURITY_BLOCKED"
  );
  assert.throws(
    () => normalizeCcKnowledgeRequest(validRequest({ question: "kannst du pushen" })),
    (error) => error.code === "SECURITY_BLOCKED"
  );
});

test("a non-object request is rejected", () => {
  assert.throws(() => normalizeCcKnowledgeRequest(null), CcKnowledgeError);
  assert.throws(() => normalizeCcKnowledgeRequest("free text"), CcKnowledgeError);
});

test("unknown context fields are rejected via the reused validator", () => {
  assert.throws(() => normalizeCcKnowledgeRequest(validRequest({ context: { projectId: "p1", projectName: "P", extra: "nope" } })), CcKnowledgeError);
});

test("a path-like context field is rejected via the reused validator", () => {
  assert.throws(() => normalizeCcKnowledgeRequest(validRequest({ context: { projectId: "p1", projectName: "ok", branch: "a\\b" } })), CcKnowledgeError);
});
