import test from "node:test";
import assert from "node:assert/strict";
import { searchKnowledgeChunks } from "../orchestrator/knowledge/rag-search.js";

function chunk(overrides) {
  return {
    sourceDoc: "x.md",
    section: "A",
    docStatus: "Accepted",
    docVersion: "1.0",
    text: "some text",
    indexedAt: new Date().toISOString(),
    embedding: [1, 0, 0],
    ...overrides
  };
}

test("returns the closest match above the threshold", () => {
  const chunks = [chunk({ embedding: [1, 0, 0] }), chunk({ embedding: [0, 1, 0] })];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, { minSimilarity: 0.5 });
  assert.equal(results.length, 1);
  assert.ok(results[0].similarity > 0.99);
});

test("no result above the threshold yields an explicit empty result, not a fallback", () => {
  const chunks = [chunk({ embedding: [0, 1, 0] })];
  const result = searchKnowledgeChunks([1, 0, 0], chunks, { minSimilarity: 0.9 });
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.rankedResults, []);
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
  const chunks = Array.from({ length: 20 }, (_, i) => chunk({ sourceDoc: `x${i}.md`, embedding: [1, 0, 0] }));
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, { minSimilarity: 0.5, topK: 50 });
  assert.equal(results.length, 5);
});

test("a larger candidate pool keeps a relevant second document despite stronger duplicate chunks", () => {
  const chunks = [
    chunk({ sourceDoc: "dominant.md", section: "A1", embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "dominant.md", section: "A2", embedding: [1, 0.03, 0] }),
    chunk({ sourceDoc: "dominant.md", section: "A3", embedding: [1, 0.04, 0] }),
    chunk({ sourceDoc: "other.md", section: "B1", embedding: [1, 0.05, 0] })
  ];
  const { results, rankedResults } = searchKnowledgeChunks([1, 0, 0], chunks, {
    minSimilarity: 0.5,
    topK: 3,
    maxCombinedChars: 2_000
  });
  assert.deepEqual(rankedResults.map((result) => result.sourceDoc), ["dominant.md", "other.md", "dominant.md"]);
  assert.ok(results.some((result) => result.sourceDoc === "other.md"));
});

test("document diversification is deterministic when similarities tie", () => {
  const chunks = [
    chunk({ sourceDoc: "a.md", section: "A1" }),
    chunk({ sourceDoc: "a.md", section: "A2" }),
    chunk({ sourceDoc: "b.md", section: "B1" }),
    chunk({ sourceDoc: "c.md", section: "C1" })
  ];
  const run = () => searchKnowledgeChunks([1, 0, 0], chunks, { topK: 3 }).rankedResults
    .map((result) => `${result.sourceDoc}:${result.section}`);
  assert.deepEqual(run(), ["a.md:A1", "b.md:B1", "c.md:C1"]);
  assert.deepEqual(run(), run());
});

test("a long first hit cannot consume the complete context budget of later sources", () => {
  const chunks = [
    chunk({ sourceDoc: "first.md", text: "x".repeat(1_900), embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "second.md", text: "y".repeat(700), embedding: [1, 0.03, 0] }),
    chunk({ sourceDoc: "third.md", text: "z".repeat(700), embedding: [1, 0.04, 0] })
  ];
  const { results, rankedResults, truncated } = searchKnowledgeChunks([1, 0, 0], chunks, {
    minSimilarity: 0.5,
    topK: 3,
    maxCombinedChars: 2_000
  });
  assert.equal(truncated, true);
  assert.deepEqual(results.map((result) => result.sourceDoc), ["first.md", "second.md", "third.md"]);
  assert.deepEqual(rankedResults.map((result) => result.snippet.length), [1_900, 700, 700]);
  assert.ok(results.every((result) => result.snippet.length >= 256));
  assert.ok(results.reduce((sum, result) => sum + result.snippet.length, 0) <= 2_000);
});

test("short early snippets leave unused budget to later sources", () => {
  const chunks = [
    chunk({ sourceDoc: "first.md", text: "short", embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "second.md", text: "y".repeat(1_900), embedding: [1, 0.03, 0] })
  ];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, { topK: 2, maxCombinedChars: 2_000 });
  assert.equal(results[0].snippet, "short");
  assert.ok(results[1].snippet.length > 1_700);
  assert.ok(results.reduce((sum, result) => sum + result.snippet.length, 0) <= 2_000);
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
  const result = searchKnowledgeChunks([1, 0, 0], [], {});
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.rankedResults, []);
});
