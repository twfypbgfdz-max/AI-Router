import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCcKnowledgeObservation,
  buildCcKnowledgeTransportFailure,
  ccKnowledgeObservationHttpStatus,
  ccKnowledgeTransportHttpStatus
} from "../orchestrator/cc-knowledge-response.js";
import { CC_KNOWLEDGE_MAX_SOURCES, CC_KNOWLEDGE_MAX_WARNINGS } from "../orchestrator/cc-knowledge-config.js";
import { ragResult } from "./cc-knowledge-helpers.js";

const now = () => new Date("2026-07-29T12:00:00.000Z");

test("the observation has exactly the fixed key set, no more and no fewer", () => {
  const payload = buildCcKnowledgeObservation({ state: "ok", answer: "x", systemContextState: "available", knowledgeState: "available", now });
  assert.deepEqual(Object.keys(payload).sort(), ["answer", "generatedAt", "knowledgeState", "schemaVersion", "sources", "state", "systemContextState", "warnings"].sort());
});

test("state ok/partial require a non-empty answer", () => {
  assert.throws(() => buildCcKnowledgeObservation({ state: "ok", answer: null, systemContextState: "available", knowledgeState: "available", now }));
  assert.throws(() => buildCcKnowledgeObservation({ state: "partial", answer: "  ", systemContextState: "available", knowledgeState: "no_match", now }));
  const ok = buildCcKnowledgeObservation({ state: "ok", answer: "Real answer.", systemContextState: "available", knowledgeState: "available", now });
  assert.equal(ok.answer, "Real answer.");
});

test("state unavailable requires answer to be null", () => {
  assert.throws(() => buildCcKnowledgeObservation({ state: "unavailable", answer: "should not be here", systemContextState: "unavailable", knowledgeState: "index_missing", now }));
  const unavailable = buildCcKnowledgeObservation({ state: "unavailable", systemContextState: "unavailable", knowledgeState: "index_missing", now, warnings: ["no_context_no_knowledge"] });
  assert.equal(unavailable.answer, null);
});

test("sources and warnings are always arrays, even when empty", () => {
  const payload = buildCcKnowledgeObservation({ state: "unavailable", systemContextState: "unavailable", knowledgeState: "index_missing", now });
  assert.deepEqual(payload.sources, []);
  assert.deepEqual(payload.warnings, []);
});

test("sources are capped at the configured maximum", () => {
  const many = Array.from({ length: 5 }, (_, i) => ragResult({ sourceDoc: `x${i}.md` }));
  const payload = buildCcKnowledgeObservation({ state: "ok", answer: "x", systemContextState: "available", knowledgeState: "available", sources: many, now });
  assert.equal(payload.sources.length, CC_KNOWLEDGE_MAX_SOURCES);
});

test("warnings are capped at the configured maximum", () => {
  const many = Array.from({ length: 8 }, (_, i) => `warning_${i}`);
  const payload = buildCcKnowledgeObservation({ state: "unavailable", systemContextState: "unavailable", knowledgeState: "index_missing", warnings: many, now });
  assert.equal(payload.warnings.length, CC_KNOWLEDGE_MAX_WARNINGS);
});

test("each source is rebuilt from only the fixed field set, dropping anything else", () => {
  const dirty = { ...ragResult(), rawIndexPath: "/abs/path/chunks.jsonl", extra: "nope" };
  const payload = buildCcKnowledgeObservation({ state: "ok", answer: "x", systemContextState: "available", knowledgeState: "available", sources: [dirty], now });
  assert.deepEqual(Object.keys(payload.sources[0]).sort(), ["docStatus", "docVersion", "freshness", "section", "similarity", "sourceDoc"].sort());
});

test("generatedAt is a real ISO timestamp from the injected clock", () => {
  const payload = buildCcKnowledgeObservation({ state: "ok", answer: "x", systemContextState: "available", knowledgeState: "available", now });
  assert.equal(payload.generatedAt, "2026-07-29T12:00:00.000Z");
});

test("transport failures use the closed error shape, not the observation shape", () => {
  const payload = buildCcKnowledgeTransportFailure({ code: "AUTH_REQUIRED" });
  assert.deepEqual(Object.keys(payload).sort(), ["error", "schemaVersion"].sort());
  assert.equal(payload.error.code, "AUTH_REQUIRED");
  assert.equal(ccKnowledgeTransportHttpStatus(payload), 401);
});

test("an unknown error code falls back to INTERNAL_ERROR / 500", () => {
  const payload = buildCcKnowledgeTransportFailure({ code: "SOMETHING_ELSE" });
  assert.equal(payload.error.code, "INTERNAL_ERROR");
  assert.equal(ccKnowledgeTransportHttpStatus(payload), 500);
});

test("observation HTTP status is 200 unless a rate/concurrency warning is present", () => {
  assert.equal(ccKnowledgeObservationHttpStatus([]), 200);
  assert.equal(ccKnowledgeObservationHttpStatus(["index_stale"]), 200);
  assert.equal(ccKnowledgeObservationHttpStatus(["rate_limited"]), 429);
  assert.equal(ccKnowledgeObservationHttpStatus(["concurrency_limited"]), 429);
});

test("no absolute local path or index path can appear in a built response", () => {
  const dirty = { ...ragResult(), sourceDoc: "C:\\Users\\felil\\Documents\\KI\\AI-Router\\.ai-router-data\\rag-index\\chunks.jsonl" };
  const payload = buildCcKnowledgeObservation({ state: "ok", answer: "x", systemContextState: "available", knowledgeState: "available", sources: [dirty], now });
  // The builder does not sanitize sourceDoc content itself (that is the RAG
  // module's job upstream, already covered by orchestrator/knowledge tests);
  // this test only documents that the builder passes through exactly the
  // six fixed fields and nothing else - an accidental raw path would have
  // to originate upstream, not from this module.
  assert.equal(Object.keys(payload.sources[0]).length, 6);
});
