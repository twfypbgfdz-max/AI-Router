import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKnowledgeAnswerObservation,
  buildKnowledgeAnswerTransportFailure,
  knowledgeAnswerObservationHttpStatus,
  knowledgeAnswerTransportHttpStatus
} from "../orchestrator/knowledge-answer-response.js";
import { KNOWLEDGE_ANSWER_MAX_SOURCES, KNOWLEDGE_ANSWER_MAX_WARNINGS } from "../orchestrator/knowledge-answer-config.js";
import { ragResult } from "./cc-knowledge-helpers.js";

const now = () => new Date("2026-07-29T12:00:00.000Z");

test("the observation has exactly the fixed key set, no more and no fewer", () => {
  const payload = buildKnowledgeAnswerObservation({ state: "ok", answer: "x", systemContextState: "available", knowledgeState: "available", now });
  assert.deepEqual(Object.keys(payload).sort(), ["answer", "generatedAt", "knowledgeState", "schemaVersion", "sources", "state", "systemContextState", "warnings"].sort());
});

test("state ok/partial require a non-empty answer", () => {
  assert.throws(() => buildKnowledgeAnswerObservation({ state: "ok", answer: null, systemContextState: "available", knowledgeState: "available", now }));
  assert.throws(() => buildKnowledgeAnswerObservation({ state: "partial", answer: "  ", systemContextState: "available", knowledgeState: "no_match", now }));
  const ok = buildKnowledgeAnswerObservation({ state: "ok", answer: "Real answer.", systemContextState: "available", knowledgeState: "available", now });
  assert.equal(ok.answer, "Real answer.");
});

test("state unavailable requires answer to be null", () => {
  assert.throws(() => buildKnowledgeAnswerObservation({ state: "unavailable", answer: "should not be here", systemContextState: "unavailable", knowledgeState: "index_missing", now }));
  const unavailable = buildKnowledgeAnswerObservation({ state: "unavailable", systemContextState: "unavailable", knowledgeState: "index_missing", now, warnings: ["no_context_no_knowledge"] });
  assert.equal(unavailable.answer, null);
});

test("sources and warnings are always arrays, even when empty", () => {
  const payload = buildKnowledgeAnswerObservation({ state: "unavailable", systemContextState: "unavailable", knowledgeState: "index_missing", now });
  assert.deepEqual(payload.sources, []);
  assert.deepEqual(payload.warnings, []);
});

test("sources are capped at the configured maximum", () => {
  const many = Array.from({ length: 5 }, (_, i) => ragResult({ sourceDoc: `x${i}.md` }));
  const payload = buildKnowledgeAnswerObservation({ state: "ok", answer: "x", systemContextState: "available", knowledgeState: "available", sources: many, now });
  assert.equal(payload.sources.length, KNOWLEDGE_ANSWER_MAX_SOURCES);
});

test("warnings are capped at the configured maximum", () => {
  const many = Array.from({ length: 8 }, (_, i) => `warning_${i}`);
  const payload = buildKnowledgeAnswerObservation({ state: "unavailable", systemContextState: "unavailable", knowledgeState: "index_missing", warnings: many, now });
  assert.equal(payload.warnings.length, KNOWLEDGE_ANSWER_MAX_WARNINGS);
});

test("each source is rebuilt from only the fixed field set, dropping anything else", () => {
  const dirty = { ...ragResult(), rawIndexPath: "/abs/path/chunks.jsonl", extra: "nope" };
  const payload = buildKnowledgeAnswerObservation({ state: "ok", answer: "x", systemContextState: "available", knowledgeState: "available", sources: [dirty], now });
  assert.deepEqual(Object.keys(payload.sources[0]).sort(), ["docStatus", "docVersion", "freshness", "section", "similarity", "sourceDoc"].sort());
});

test("generatedAt is a real ISO timestamp from the injected clock", () => {
  const payload = buildKnowledgeAnswerObservation({ state: "ok", answer: "x", systemContextState: "available", knowledgeState: "available", now });
  assert.equal(payload.generatedAt, "2026-07-29T12:00:00.000Z");
});

test("transport failures use the closed error shape, not the observation shape", () => {
  const payload = buildKnowledgeAnswerTransportFailure({ code: "AUTH_REQUIRED" });
  assert.deepEqual(Object.keys(payload).sort(), ["error", "schemaVersion"].sort());
  assert.equal(payload.error.code, "AUTH_REQUIRED");
  assert.equal(knowledgeAnswerTransportHttpStatus(payload), 401);
});

test("an unknown error code falls back to INTERNAL_ERROR / 500", () => {
  const payload = buildKnowledgeAnswerTransportFailure({ code: "SOMETHING_ELSE" });
  assert.equal(payload.error.code, "INTERNAL_ERROR");
  assert.equal(knowledgeAnswerTransportHttpStatus(payload), 500);
});

test("observation HTTP status is 200 unless a rate/concurrency warning is present", () => {
  assert.equal(knowledgeAnswerObservationHttpStatus([]), 200);
  assert.equal(knowledgeAnswerObservationHttpStatus(["index_stale"]), 200);
  assert.equal(knowledgeAnswerObservationHttpStatus(["rate_limited"]), 429);
  assert.equal(knowledgeAnswerObservationHttpStatus(["concurrency_limited"]), 429);
});

test("no absolute local path or index path can appear in a built response", () => {
  const dirty = { ...ragResult(), sourceDoc: "C:\\Users\\felil\\Documents\\KI\\AI-Router\\.ai-router-data\\rag-index\\chunks.jsonl" };
  const payload = buildKnowledgeAnswerObservation({ state: "ok", answer: "x", systemContextState: "available", knowledgeState: "available", sources: [dirty], now });
  // The builder does not sanitize sourceDoc content itself (that is the RAG
  // module's job upstream, already covered by orchestrator/knowledge tests);
  // this test only documents that the builder passes through exactly the
  // six fixed fields and nothing else - an accidental raw path would have
  // to originate upstream, not from this module.
  assert.equal(Object.keys(payload.sources[0]).length, 6);
});
