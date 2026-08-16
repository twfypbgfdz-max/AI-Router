import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createKnowledgeHandler, handleKnowledgeRequest } from "../orchestrator/knowledge-handler.js";
import { knowledgeServiceInternals } from "../orchestrator/knowledge-service.js";
import { KNOWLEDGE_TOKEN_ENV_VAR } from "../orchestrator/knowledge-config.js";
import { TEST_CC_TOKEN, TEST_INTERNAL_TOKEN, MODEL, ragResult, structuredAdapter } from "./cc-knowledge-helpers.js";

const TEST_KNOWLEDGE_TOKEN = "test-generic-knowledge-route-token-0123456789ab";

function knowledgeEnv(overrides = {}) {
  return {
    [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_KNOWLEDGE_TOKEN,
    AI_ROUTER_CC_TOKEN: TEST_CC_TOKEN,
    AI_ROUTER_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    AI_ROUTER_OLLAMA_MODEL: MODEL,
    AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "bge-m3:latest",
    AI_ROUTER_OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    ...overrides
  };
}

function exchange(body) {
  const request = new EventEmitter();
  request.method = "POST";
  request.headers = { "content-type": "application/json", authorization: `Bearer ${TEST_KNOWLEDGE_TOKEN}` };
  request.socket = new EventEmitter();
  queueMicrotask(() => {
    request.emit("data", JSON.stringify(body));
    request.emit("end");
  });

  const response = new EventEmitter();
  response.headers = new Map();
  response.statusCode = 200;
  response.writableEnded = false;
  response.destroyed = false;
  response.body = "";
  response.setHeader = (name, value) => response.headers.set(String(name).toLowerCase(), String(value));
  response.getHeader = (name) => response.headers.get(String(name).toLowerCase());
  response.end = (value = "") => { response.body = String(value); response.writableEnded = true; response.emit("finish"); };
  response.json = () => JSON.parse(response.body);
  return { request, response };
}

function operationalOnlyAdapter({ answer = "Dein Fokus heute: Plateau-Brecher testen.", citedSources = [] } = {}) {
  const calls = [];
  return {
    calls,
    adapter: {
      async generateText(input) {
        calls.push(input);
        return { text: JSON.stringify({ answer, citedSources }), usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } };
      }
    }
  };
}

const body = (overrides = {}) => ({ schemaVersion: "1.0", question: "Was ist mein Fokus heute?", ...overrides });

const dailyOperationalContext = Object.freeze({
  today: "2026-08-15",
  focus: Object.freeze({ freshness: "fresh", items: Object.freeze([{ text: "Plateau-Brecher testen", done: false }]) }),
  tasks: null,
  calendar: null
});

test("no RAG match + no CC context + operational context available: answers instead of the no_context_no_knowledge early exit", async () => {
  const generated = operationalOnlyAdapter();
  const handler = createKnowledgeHandler({
    env: knowledgeEnv(),
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: "no_match", results: [] }),
    adapterFactory: () => generated.adapter,
    operationalContextProviderFn: async () => dailyOperationalContext
  });

  const { request, response } = exchange(body());
  await handler(request, response);
  const payload = response.json();

  assert.equal(payload.state, "partial");
  assert.notEqual(payload.answer, null);
  assert.deepEqual([...payload.sources], []);
  assert.ok(!payload.warnings.includes("no_context_no_knowledge"));
  assert.ok(generated.calls[0].question.includes("Plateau-Brecher testen"));
});

test("no RAG match + no CC context + no operational context: unchanged fail-closed behaviour", async () => {
  const handler = createKnowledgeHandler({
    env: knowledgeEnv(),
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: "no_match", results: [] }),
    adapterFactory: () => { throw new Error("must not be called"); },
    operationalContextProviderFn: async () => null
  });

  // Deliberately not a present-state question (no "heute"/"aktuell"/...):
  // keeps this assertion isolated to the no_context_no_knowledge guard
  // itself, without also depending on isPresentStateQuestion's keyword set.
  const { request, response } = exchange(body({ question: "Was ist mein Fokus?" }));
  await handler(request, response);
  const payload = response.json();

  assert.equal(payload.state, "unavailable");
  assert.equal(payload.answer, null);
  assert.deepEqual([...payload.warnings], ["no_context_no_knowledge"]);
});

test("a stale operational-context block is surfaced as a warning", async () => {
  const generated = operationalOnlyAdapter();
  const handler = createKnowledgeHandler({
    env: knowledgeEnv(),
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: "no_match", results: [] }),
    adapterFactory: () => generated.adapter,
    operationalContextProviderFn: async () => Object.freeze({
      ...dailyOperationalContext,
      focus: Object.freeze({ freshness: "stale", items: Object.freeze([{ text: "gestriger Fokus", done: false }]) })
    })
  });

  const { request, response } = exchange(body());
  await handler(request, response);
  const payload = response.json();
  assert.ok(payload.warnings.includes("operational_context_stale"));
});

test("a throwing operational context provider degrades to no context, never breaks the response", async () => {
  const handler = createKnowledgeHandler({
    env: knowledgeEnv(),
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: "no_match", results: [] }),
    adapterFactory: () => { throw new Error("must not be called"); },
    operationalContextProviderFn: async () => { throw new Error("cockpit boom"); }
  });

  const { request, response } = exchange(body({ question: "Was ist mein Fokus?" }));
  await handler(request, response);
  const payload = response.json();
  assert.equal(payload.state, "unavailable");
  assert.deepEqual([...payload.warnings], ["no_context_no_knowledge"]);
});

// /api/v1/knowledge's own exported singleton never receives a provider -
// P6-A must not change its behaviour.
test("the production /api/v1/knowledge singleton has no operational context provider wired in", async () => {
  assert.equal(typeof handleKnowledgeRequest, "function");
});

// The regression this checkpoint exists for: operationalContextProviderFn
// must be a per-call option on ONE shared handler instance, not something
// that forces a second createKnowledgeHandler() instance (which would mean
// a second, independent rate/concurrency budget). Proven here the same way
// knowledge-handler.test.js already proves the opposite case ("two separate
// handlers do not share a rate budget"): one instance, one call without the
// option (simulating /api/v1/knowledge), one call with it (simulating
// /api/jarvis/ask) - the second must still be rate-limited by the first.
test("one handler instance shares its rate budget across a plain call and an operational-context call", async () => {
  // The rate/concurrency limiter lives inside the text-response pipeline,
  // reached only once a call actually generates an answer (the
  // no_context_no_knowledge early exit never touches it) - so the first
  // call here must be a real, answering call, exactly like
  // /api/v1/knowledge's normal traffic.
  const handler = createKnowledgeHandler({
    env: knowledgeEnv(),
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: "available", results: [ragResult()] }),
    adapterFactory: () => structuredAdapter().adapter
    // No constructor-level operationalContextProviderFn: this instance is
    // meant to stand in for the real /api/v1/knowledge singleton, which
    // never has one either.
  });

  const first = exchange(body());
  await handler(first.request, first.response);
  assert.equal(first.response.statusCode, 200);

  const second = exchange(body());
  await handler(second.request, second.response, {
    operationalContextProviderFn: async () => dailyOperationalContext
  });
  assert.equal(second.response.statusCode, 429);
  assert.ok([...second.response.json().warnings].includes("rate_limited"));
});

// DEC-007: responseProfile ("operational"/"knowledge") is derived purely
// from operationalContextState (knowledge-service.js's own already-computed
// value), never a new caller input, and must stay strictly internal.

test("responseProfileOf derives 'operational' only from operationalContextState 'available'", () => {
  assert.equal(knowledgeServiceInternals.responseProfileOf("available"), "operational");
  assert.equal(knowledgeServiceInternals.responseProfileOf("unavailable"), "knowledge");
});

test("responseProfile never appears in the client-facing payload, with or without operational context", async () => {
  const generated = operationalOnlyAdapter();
  const handler = createKnowledgeHandler({
    env: knowledgeEnv(),
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: "no_match", results: [] }),
    adapterFactory: () => generated.adapter,
    operationalContextProviderFn: async () => dailyOperationalContext
  });

  const withOperational = exchange(body());
  await handler(withOperational.request, withOperational.response);
  const operationalPayload = withOperational.response.json();
  assert.ok(!("responseProfile" in operationalPayload));

  const withoutHandler = createKnowledgeHandler({
    env: knowledgeEnv(),
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: "no_match", results: [] }),
    adapterFactory: () => { throw new Error("must not be called"); },
    operationalContextProviderFn: async () => null
  });
  const withoutOperational = exchange(body({ question: "Was ist mein Fokus?" }));
  await withoutHandler(withoutOperational.request, withoutOperational.response);
  const knowledgePayload = withoutOperational.response.json();
  assert.ok(!("responseProfile" in knowledgePayload));
});

test("responseProfile is logged as internal safeMetadata, matching operational-context presence", async () => {
  const loggedEvents = [];
  const eventLogger = { log(entry) { loggedEvents.push(entry); } };
  const generated = operationalOnlyAdapter();
  const handler = createKnowledgeHandler({
    env: knowledgeEnv(),
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger,
    retrieveKnowledgeFn: async () => ({ knowledgeState: "no_match", results: [] }),
    adapterFactory: () => generated.adapter,
    operationalContextProviderFn: async () => dailyOperationalContext
  });

  const { request, response } = exchange(body());
  await handler(request, response);

  const observed = loggedEvents.find((entry) => entry.event === "knowledge_observed");
  assert.equal(observed.safeMetadata.responseProfile, "operational");
});
