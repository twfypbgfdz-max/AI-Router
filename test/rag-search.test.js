import test from "node:test";
import assert from "node:assert/strict";
import { searchKnowledgeChunks } from "../orchestrator/knowledge/rag-search.js";

function chunk(overrides) {
  return { sourceDoc: "x.md", section: "A", docStatus: "Accepted", docVersion: "1.0", text: "some text", indexedAt: new Date().toISOString(), embedding: [1, 0, 0], ...overrides };
}

test("returns the closest match above the threshold", () => {
  const chunks = [chunk({ embedding: [1, 0, 0] }), chunk({ embedding: [0, 1, 0] })];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, { minSimilarity: 0.5 });
  assert.equal(results.length, 1);
  assert.ok(results[0].similarity > 0.99);
});

test("no result above the threshold yields an explicit empty result, not a fallback", () => {
  const chunks = [chunk({ embedding: [0, 1, 0] })];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, { minSimilarity: 0.9 });
  assert.deepEqual(results, []);
});

test("boundary: a similarity exactly at the threshold is included", () => {
  const chunks = [chunk({ embedding: [1, 0, 0] })];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, { minSimilarity: 1 });
  assert.equal(results.length, 1);
});

test("boundary: a similarity just under the threshold is excluded", () => {
  const chunks = [chunk({ embedding: [0.99, 0.14, 0] })];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, { minSimilarity: 0.999 });
  assert.equal(results.length, 0);
});

test("caps results at topK", () => {
  const chunks = Array.from({ length: 10 }, (_, i) => chunk({ sourceDoc: `x${i}.md`, embedding: [1, 0, 0] }));
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, { minSimilarity: 0.5, topK: 3 });
  assert.equal(results.length, 3);
});

test("topK is hard-capped even if a caller requests more than the maximum", () => {
  const chunks = Array.from({ length: 10 }, (_, i) => chunk({ sourceDoc: `x${i}.md`, embedding: [1, 0, 0] }));
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, { minSimilarity: 0.5, topK: 50 });
  assert.equal(results.length, 5);
});

test("stops adding results once the combined snippet length limit is reached", () => {
  const chunks = [
    chunk({ sourceDoc: "a.md", text: "x".repeat(1500), embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "b.md", text: "y".repeat(1500), embedding: [1, 0, 0] })
  ];
  const { results, truncated } = searchKnowledgeChunks([1, 0, 0], chunks, { minSimilarity: 0.5, topK: 5, maxCombinedChars: 2000 });
  assert.equal(results.length, 1);
  assert.equal(truncated, true);
});

test("result carries relative source, section, status/version, similarity, indexedAt and freshness", () => {
  const chunks = [chunk({ sourceDoc: "10_Apps/doc.md", section: "2 > 2.1", docStatus: "Accepted", docVersion: "1.1", indexedAt: new Date().toISOString() })];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, { minSimilarity: 0.5 });
  const [result] = results;
  assert.equal(result.sourceDoc, "10_Apps/doc.md");
  assert.equal(result.section, "2 > 2.1");
  assert.equal(result.docStatus, "Accepted");
  assert.equal(result.docVersion, "1.1");
  assert.equal(result.freshness, "fresh");
  assert.ok(Number.isFinite(result.similarity));
});

test("marks a result stale once it exceeds the freshness age", () => {
  const oldTimestamp = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
  const chunks = [chunk({ indexedAt: oldTimestamp })];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, { minSimilarity: 0.5, freshnessMaxAgeMs: 24 * 60 * 60_000 });
  assert.equal(results[0].freshness, "stale");
});

test("an empty chunk list yields an empty result", () => {
  const { results } = searchKnowledgeChunks([1, 0, 0], [], {});
  assert.deepEqual(results, []);
});
