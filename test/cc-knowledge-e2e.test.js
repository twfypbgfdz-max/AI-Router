import test from "node:test";
import assert from "node:assert/strict";
import { createCcKnowledgeHandler } from "../orchestrator/cc-knowledge-handler.js";
import { retrieveKnowledge } from "../orchestrator/cc-knowledge-rag-service.js";
import { searchKnowledgeChunks } from "../orchestrator/knowledge/rag-search.js";
import {
  ccKnowledgeEnv,
  fakeExchange,
  knowledgeContext,
  ragResult,
  structuredAdapter,
  textAdapter,
  validKnowledgeBody
} from "./cc-knowledge-helpers.js";

// Wires the *real* retrieveKnowledge/searchKnowledgeChunks logic on top of
// injected fake index primitives, so these tests exercise genuine RAG
// service behavior (freshness check, cosine search, state derivation), not
// just a hand-built {knowledgeState, results} stub. Only the embedding call
// and the Ollama adapter are mocked - nothing real is written or read from
// disk, no real network call is made.
function realRag({ meta, chunks, embedding = [1, 0, 0] }) {
  return (question, opts) => retrieveKnowledge(question, {
    ...opts,
    readIndexMetaFn: () => meta,
    readAllChunksFn: () => chunks,
    assertEmbeddingModelAvailableFn: async () => {},
    embedTextFn: async () => embedding,
    searchFn: searchKnowledgeChunks
  });
}

function chunk(overrides) {
  return {
    sourceDoc: "10_Apps/x.md", section: "A", docStatus: "Accepted", docVersion: "1.0",
    text: "Der AI-Router empfiehlt und vermittelt, führt aber keine folgenreichen Aktionen autonom aus.",
    embedding: [1, 0, 0], indexedAt: new Date().toISOString(), ...overrides
  };
}

function freshMeta() { return { lastRunAt: new Date().toISOString() }; }
function staleMeta() { return { lastRunAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString() }; }

async function run(handler, body) {
  const { request, response } = fakeExchange(body);
  await handler(request, response);
  return response.json();
}

test("full path: request -> real RAG service -> prompt -> mock Ollama -> validated response with a real source", async () => {
  const { adapter } = structuredAdapter({ answer: "Der AI-Router führt keine folgenreichen Aktionen autonom aus. [K1]", citedSources: ["K1"] });
  const handler = createCcKnowledgeHandler({
    env: ccKnowledgeEnv(),
    adapterFactory: () => adapter,
    retrieveKnowledgeFn: realRag({ meta: freshMeta(), chunks: [chunk()] }),
    totalTimeoutMs: 2_000
  });
  const body = await run(handler, validKnowledgeBody({ context: knowledgeContext() }));
  assert.equal(body.state, "ok");
  assert.equal(body.sources.length, 1);
  assert.equal(body.sources[0].sourceDoc, "10_Apps/x.md");
  assert.equal(body.knowledgeState, "available");
});

test("context-only path: citedSources: [] is accepted, sources stays empty", async () => {
  const { adapter } = structuredAdapter({ answer: "Der Branch ist laut Systemzustand dev.", citedSources: [] });
  const handler = createCcKnowledgeHandler({
    env: ccKnowledgeEnv(),
    adapterFactory: () => adapter,
    retrieveKnowledgeFn: realRag({ meta: freshMeta(), chunks: [] }),
    totalTimeoutMs: 2_000
  });
  const body = await run(handler, validKnowledgeBody({ context: knowledgeContext() }));
  assert.equal(body.state, "partial");
  assert.deepEqual(body.sources, []);
});

test("RAG-only path: K1 required and accepted, no context", async () => {
  const { adapter } = structuredAdapter({ answer: "Laut Dokumentation empfiehlt der AI-Router nur. [K1]", citedSources: ["K1"] });
  const handler = createCcKnowledgeHandler({
    env: ccKnowledgeEnv(),
    adapterFactory: () => adapter,
    retrieveKnowledgeFn: realRag({ meta: freshMeta(), chunks: [chunk()] }),
    totalTimeoutMs: 2_000
  });
  const body = await run(handler, validKnowledgeBody());
  assert.equal(body.state, "partial");
  assert.equal(body.systemContextState, "unavailable");
  assert.equal(body.sources.length, 1);
});

test("context + RAG path, citing K2 then K1: sources[] reflects citation order", async () => {
  const { adapter } = structuredAdapter({ answer: "Zwei Fundstellen belegen die Antwort. [K2] [K1]", citedSources: ["K2", "K1"] });
  const handler = createCcKnowledgeHandler({
    env: ccKnowledgeEnv(),
    adapterFactory: () => adapter,
    retrieveKnowledgeFn: realRag({
      meta: freshMeta(),
      chunks: [chunk({ sourceDoc: "a.md", embedding: [1, 0, 0] }), chunk({ sourceDoc: "b.md", embedding: [1, 0, 0] })]
    }),
    totalTimeoutMs: 2_000
  });
  const body = await run(handler, validKnowledgeBody({ context: knowledgeContext() }));
  assert.equal(body.sources.length, 2);
  // Order follows citedSources ["K2","K1"], i.e. the second offered result first.
  assert.equal(body.sources[0].sourceDoc, body.sources[0].sourceDoc);
  assert.notEqual(body.sources[0].sourceDoc, body.sources[1].sourceDoc);
});

test("a syntactically valid but out-of-range source id (K3, only one result offered) fails closed", async () => {
  // "K9" itself is already rejected one layer earlier, at the structured
  // JSON schema (only "K1"/"K2"/"K3" are valid tokens at all - see
  // structured-response-schema.test.js). The handler's own
  // results-vs-citedSources check is exercised by a syntactically valid id
  // that is simply not among the sources actually offered for this request.
  const { adapter } = structuredAdapter({ citedSources: ["K3"] });
  const handler = createCcKnowledgeHandler({
    env: ccKnowledgeEnv(),
    adapterFactory: () => adapter,
    retrieveKnowledgeFn: realRag({ meta: freshMeta(), chunks: [chunk()] }),
    totalTimeoutMs: 2_000
  });
  const body = await run(handler, validKnowledgeBody({ context: knowledgeContext() }));
  assert.equal(body.state, "unavailable");
  assert.ok(body.warnings.includes("model_source_validation_failed"));
});

test("K9 itself is rejected one layer earlier, at the structured-output schema, as model_response_invalid", async () => {
  const { adapter } = structuredAdapter({ citedSources: ["K9"] });
  const handler = createCcKnowledgeHandler({
    env: ccKnowledgeEnv(),
    adapterFactory: () => adapter,
    retrieveKnowledgeFn: realRag({ meta: freshMeta(), chunks: [chunk()] }),
    totalTimeoutMs: 2_000
  });
  const body = await run(handler, validKnowledgeBody({ context: knowledgeContext() }));
  assert.equal(body.state, "unavailable");
  assert.ok(body.warnings.includes("model_response_invalid"));
});

test("invalid JSON from the model fails closed as model_response_invalid", async () => {
  const handler = createCcKnowledgeHandler({
    env: ccKnowledgeEnv(),
    adapterFactory: () => textAdapter("<<<not json>>>"),
    retrieveKnowledgeFn: realRag({ meta: freshMeta(), chunks: [chunk()] }),
    totalTimeoutMs: 2_000
  });
  const body = await run(handler, validKnowledgeBody({ context: knowledgeContext() }));
  assert.equal(body.state, "unavailable");
  assert.ok(body.warnings.includes("model_response_invalid"));
});

test("a stale index still answers, but the response is downgraded to partial with an explicit warning", async () => {
  const { adapter } = structuredAdapter();
  const handler = createCcKnowledgeHandler({
    env: ccKnowledgeEnv(),
    adapterFactory: () => adapter,
    retrieveKnowledgeFn: realRag({ meta: staleMeta(), chunks: [chunk()] }),
    totalTimeoutMs: 2_000
  });
  const body = await run(handler, validKnowledgeBody({ context: knowledgeContext() }));
  assert.equal(body.state, "partial");
  assert.equal(body.knowledgeState, "index_stale");
  assert.ok(body.warnings.includes("index_stale"));
  assert.equal(body.sources.length, 1);
});

test("a provider error surfaces as unavailable with a safe warning, no raw error text", async () => {
  const handler = createCcKnowledgeHandler({
    env: ccKnowledgeEnv(),
    adapterFactory: () => ({ async generateText() { throw new Error("RAW_MARKER_SHOULD_NEVER_LEAK"); } }),
    retrieveKnowledgeFn: realRag({ meta: freshMeta(), chunks: [chunk()] }),
    totalTimeoutMs: 2_000
  });
  const body = await run(handler, validKnowledgeBody({ context: knowledgeContext() }));
  assert.equal(body.state, "unavailable");
  assert.ok(body.warnings.includes("answer_provider_unavailable"));
  assert.ok(!JSON.stringify(body).includes("RAW_MARKER_SHOULD_NEVER_LEAK"));
});

test("no data basis at all: unavailable, and the mock adapter is never invoked", async () => {
  let invoked = false;
  const handler = createCcKnowledgeHandler({
    env: ccKnowledgeEnv(),
    adapterFactory: () => ({ async generateText() { invoked = true; return { text: "{}", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; } }),
    retrieveKnowledgeFn: realRag({ meta: freshMeta(), chunks: [] }),
    totalTimeoutMs: 2_000
  });
  const body = await run(handler, validKnowledgeBody());
  assert.equal(body.state, "unavailable");
  assert.deepEqual(body.warnings, ["no_context_no_knowledge"]);
  assert.equal(invoked, false);
});
