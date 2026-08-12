import test from "node:test";
import assert from "node:assert/strict";
import { retrieveKnowledge } from "../orchestrator/knowledge-answer-rag-service.js";

const BASE_ENV = { AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "bge-m3:latest", AI_ROUTER_OLLAMA_BASE_URL: "http://localhost:11434" };

function chunk(overrides) {
  return { sourceDoc: "10_Apps/x.md", section: "A", docStatus: "Accepted", docVersion: "1.0", text: "some text", indexedAt: new Date().toISOString(), embedding: [1, 0, 0], ...overrides };
}

const noopAvailability = async () => {};
const freshMeta = () => ({ lastRunAt: new Date().toISOString() });
const staleMeta = () => ({ lastRunAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString() });

test("state available: a real match is returned", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => [chunk({ embedding: [1, 0, 0] })],
    embedTextFn: async () => [1, 0, 0],
    searchFn: () => ({ results: [{ sourceDoc: "10_Apps/x.md", section: "A", similarity: 0.9, snippet: "text", indexedAt: new Date().toISOString(), freshness: "fresh" }], truncated: false })
  });
  assert.equal(result.knowledgeState, "available");
  assert.equal(result.results.length, 1);
});

test("state no_match: search runs but finds nothing above the threshold", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => [chunk()],
    embedTextFn: async () => [1, 0, 0],
    searchFn: () => ({ results: [], truncated: false })
  });
  assert.equal(result.knowledgeState, "no_match");
  assert.deepEqual(result.results, []);
});

test("state index_missing: no index-meta at all", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: () => null,
    readAllChunksFn: () => []
  });
  assert.equal(result.knowledgeState, "index_missing");
});

test("state index_missing: index-meta exists but zero chunks", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => []
  });
  assert.equal(result.knowledgeState, "index_missing");
});

test("state index_stale: an old index still returns its matches, flagged as stale", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: staleMeta,
    readAllChunksFn: () => [chunk()],
    embedTextFn: async () => [1, 0, 0],
    searchFn: () => ({ results: [{ sourceDoc: "10_Apps/x.md", section: "A", similarity: 0.9, snippet: "text", indexedAt: new Date().toISOString(), freshness: "fresh" }], truncated: false })
  });
  assert.equal(result.knowledgeState, "index_stale");
  assert.equal(result.results.length, 1);
});

test("state index_stale: also wins over no_match when the index is old and empty of hits", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: staleMeta,
    readAllChunksFn: () => [chunk()],
    embedTextFn: async () => [1, 0, 0],
    searchFn: () => ({ results: [], truncated: false })
  });
  assert.equal(result.knowledgeState, "index_stale");
});

test("state embedding_model_unavailable: availability check throws", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: async () => { throw new Error("not installed"); },
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => [chunk()]
  });
  assert.equal(result.knowledgeState, "embedding_model_unavailable");
  assert.deepEqual(result.results, []);
});

test("state embedding_model_unavailable: embedding config itself is not configured", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: {},
    assertEmbeddingModelAvailableFn: noopAvailability
  });
  assert.equal(result.knowledgeState, "embedding_model_unavailable");
});

test("state search_failed: the embed call throws", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => [chunk()],
    embedTextFn: async () => { throw new Error("timeout"); }
  });
  assert.equal(result.knowledgeState, "search_failed");
});

test("state search_failed: an invalid embedding response also maps here", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => [chunk()],
    embedTextFn: async () => { throw Object.assign(new Error("bad shape"), { code: "EMBEDDING_RESPONSE_INVALID" }); }
  });
  assert.equal(result.knowledgeState, "search_failed");
});

test("state search_failed: the search function itself throws", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => [chunk()],
    embedTextFn: async () => [1, 0, 0],
    searchFn: () => { throw new Error("boom"); }
  });
  assert.equal(result.knowledgeState, "search_failed");
});

test("never calls the vault document loader - only pre-built chunks are read", async () => {
  let readAllChunksCalled = false;
  await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => { readAllChunksCalled = true; return [chunk()]; },
    embedTextFn: async () => [1, 0, 0],
    searchFn: () => ({ results: [], truncated: false })
  });
  assert.equal(readAllChunksCalled, true);
});

test("searchFn is called without any caller-controllable threshold or top-k options", async () => {
  let receivedArgs = null;
  await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => [chunk()],
    embedTextFn: async () => [1, 0, 0],
    searchFn: (...args) => { receivedArgs = args; return { results: [], truncated: false }; }
  });
  assert.equal(receivedArgs.length, 2);
});
