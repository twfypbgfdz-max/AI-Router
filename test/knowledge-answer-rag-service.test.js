import test from "node:test";
import assert from "node:assert/strict";
import { retrieveKnowledge as retrieveKnowledgeProduction } from "../orchestrator/knowledge-answer-rag-service.js";

const BASE_ENV = { AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "bge-m3:latest", AI_ROUTER_OLLAMA_BASE_URL: "http://localhost:11434" };

function chunk(overrides) {
  return { sourceDoc: "10_Apps/x.md", section: "A", docStatus: "Accepted", docVersion: "1.0", text: "some text", indexedAt: new Date().toISOString(), embedding: [1, 0, 0], ...overrides };
}

const noopAvailability = async () => {};
const freshMeta = () => ({ lastRunAt: new Date().toISOString(), embeddingDimensions: 3 });
const staleMeta = () => ({ lastRunAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString(), embeddingDimensions: 3 });

function retrieveKnowledge(question, options = {}) {
  return retrieveKnowledgeProduction(question, {
    readManifestFn: () => ({ schemaVersion: "2.0", documents: {} }),
    verifyIndexFreshnessFn: ({ meta }) => Object.freeze({
      state: "content_current",
      reasons: Object.freeze([]),
      lastBuiltAt: meta.lastRunAt,
      lastVerifiedAt: new Date().toISOString(),
      ageWarning: Date.now() - Date.parse(meta.lastRunAt) > 24 * 60 * 60_000,
      modelDigestVerified: true
    }),
    ...options
  });
}

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

test("an old but content-current index remains available with an age warning", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: staleMeta,
    readAllChunksFn: () => [chunk()],
    embedTextFn: async () => [1, 0, 0],
    searchFn: () => ({ results: [{ sourceDoc: "10_Apps/x.md", section: "A", similarity: 0.9, snippet: "text", indexedAt: new Date().toISOString(), freshness: "fresh" }], truncated: false })
  });
  assert.equal(result.knowledgeState, "available");
  assert.equal(result.indexVerification.state, "content_current");
  assert.equal(result.indexVerification.ageWarning, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].freshness, "fresh");
});

test("an old but content-current index can still report no_match", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: staleMeta,
    readAllChunksFn: () => [chunk()],
    embedTextFn: async () => [1, 0, 0],
    searchFn: () => ({ results: [], truncated: false })
  });
  assert.equal(result.knowledgeState, "no_match");
  assert.equal(result.indexVerification.ageWarning, true);
});

test("content_stale returns last-known-good matches as index_stale sources", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => [chunk()],
    embedTextFn: async () => [1, 0, 0],
    verifyIndexFreshnessFn: () => ({ state: "content_stale", reasons: ["document_content_changed"], ageWarning: false }),
    searchFn: () => ({ results: [{ sourceDoc: "10_Apps/x.md", section: "A", similarity: 0.9, snippet: "text", indexedAt: new Date().toISOString(), freshness: "fresh" }], truncated: false })
  });
  assert.equal(result.knowledgeState, "index_stale");
  assert.equal(result.results[0].freshness, "stale");
});

test("an allowlist removal excludes the removed document before search", async () => {
  let searchedChunks = null;
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => [chunk({ sourceDoc: "a.md" }), chunk({ sourceDoc: "removed.md" })],
    verifyIndexFreshnessFn: () => ({
      state: "content_stale", reasons: ["allowlist_changed"], lastBuiltAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(), ageWarning: false, modelDigestVerified: true,
      allowedSourceDocs: ["a.md"]
    }),
    embedTextFn: async () => [1, 0, 0],
    searchFn: (_embedding, chunks) => { searchedChunks = chunks; return { results: [], truncated: false }; }
  });
  assert.equal(result.knowledgeState, "index_stale");
  assert.deepEqual(searchedChunks.map((entry) => entry.sourceDoc), ["a.md"]);
});

test("index_incompatible stops before query embedding", async () => {
  let embedded = false;
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => [chunk()],
    verifyIndexFreshnessFn: () => ({ state: "index_incompatible", reasons: ["index_schema_mismatch"], ageWarning: false }),
    embedTextFn: async () => { embedded = true; return [1, 0, 0]; }
  });
  assert.equal(result.knowledgeState, "search_failed");
  assert.equal(result.indexVerification.state, "index_incompatible");
  assert.equal(embedded, false);
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

test("reads the pre-built chunks and delegates content verification to the freshness verifier", async () => {
  let readAllChunksCalled = false;
  let verifierCalled = false;
  await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => { readAllChunksCalled = true; return [chunk()]; },
    verifyIndexFreshnessFn: () => {
      verifierCalled = true;
      return {
        state: "content_current", reasons: [], lastBuiltAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(), ageWarning: false, modelDigestVerified: true
      };
    },
    embedTextFn: async () => [1, 0, 0],
    searchFn: () => ({ results: [], truncated: false })
  });
  assert.equal(readAllChunksCalled, true);
  assert.equal(verifierCalled, true);
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

// ---------------------------------------------------------------------------
// P1-A3: authority metadata is joined onto the server-built results
// ---------------------------------------------------------------------------

function withMetadata(sourceMetadata, searchResults) {
  return {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => [chunk()],
    embedTextFn: async () => [1, 0, 0],
    searchFn: () => ({ results: searchResults, truncated: false }),
    verifyIndexFreshnessFn: ({ meta }) => Object.freeze({
      state: "content_current",
      reasons: Object.freeze([]),
      lastBuiltAt: meta.lastRunAt,
      lastVerifiedAt: new Date().toISOString(),
      ageWarning: false,
      modelDigestVerified: true,
      allowedSourceDocs: Object.freeze(Object.keys(sourceMetadata)),
      sourceMetadata: Object.freeze(sourceMetadata)
    })
  };
}

test("the allowlist class and review date are joined onto each result", async () => {
  const result = await retrieveKnowledgeProduction("Frage", withMetadata(
    { "90_System/Profil.md": { informationClass: "personal_reference", reviewedAt: "2026-08-11" } },
    [{ sourceDoc: "90_System/Profil.md", section: "Steckbrief", similarity: 0.7, snippet: "Name: Felix", indexedAt: new Date().toISOString(), freshness: "fresh" }]
  ));
  assert.equal(result.results[0].informationClass, "personal_reference");
  assert.equal(result.results[0].reviewedAt, "2026-08-11");
  assert.equal(result.results[0].sectionValidity, "current");
});

// Only reachable if the index still holds a chunk the allowlist no longer
// describes. It must degrade to the most restrictive class, not to none.
test("a result without allowlist metadata falls back to the most restrictive class", async () => {
  const result = await retrieveKnowledgeProduction("Frage", withMetadata(
    {},
    [{ sourceDoc: "10_Apps/unknown.md", section: "A", similarity: 0.7, snippet: "text", indexedAt: new Date().toISOString(), freshness: "fresh" }]
  ));
  assert.equal(result.results[0].informationClass, "project_context");
  assert.equal(result.results[0].reviewedAt, null);
});

test("a historical section is marked historical on the result itself", async () => {
  const result = await retrieveKnowledgeProduction("Frage", withMetadata(
    { "10_Apps/00_Projektsteuerung.md": { informationClass: "project_context", reviewedAt: "2026-08-13" } },
    [{
      sourceDoc: "10_Apps/00_Projektsteuerung.md",
      section: "Projektsteuerung > Historisch dokumentierte Fortschritte (Stand 08.08.; kein heutiger Status)",
      similarity: 0.7, snippet: "Damals dokumentiert.", indexedAt: new Date().toISOString(), freshness: "fresh"
    }]
  ));
  assert.equal(result.results[0].sectionValidity, "historical");
});

// A verifier that predates the metadata field must not crash retrieval.
test("a freshness result without sourceMetadata still yields usable results", async () => {
  const result = await retrieveKnowledge("Frage", {
    env: BASE_ENV,
    assertEmbeddingModelAvailableFn: noopAvailability,
    readIndexMetaFn: freshMeta,
    readAllChunksFn: () => [chunk()],
    embedTextFn: async () => [1, 0, 0],
    searchFn: () => ({ results: [{ sourceDoc: "10_Apps/x.md", section: "A", similarity: 0.9, snippet: "text", indexedAt: new Date().toISOString(), freshness: "fresh" }], truncated: false })
  });
  assert.equal(result.knowledgeState, "available");
  assert.equal(result.results[0].informationClass, "project_context");
});
