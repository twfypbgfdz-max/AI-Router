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

test("keeps R1 intact and adds one better complete sentence from a later excluded hit", () => {
  const r1Text = "DEC-006 wurde beschlossen. ".padEnd(1_600, "x");
  const r2Text = "Der zweite Treffer ist zu gross. ".padEnd(600, "y");
  const r3Sentence = "Die Allowlist enthält **10 Dokumente einschließlich DEC-006**.";
  const chunks = [
    chunk({ sourceDoc: "r1.md", section: "R1", text: r1Text, embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "r2.md", section: "R2", text: r2Text, embedding: [0.99, 0.1, 0] }),
    chunk({
      sourceDoc: "r3.md", section: "R3", docStatus: "Draft", docVersion: "2.0",
      text: `Ein anderer Satz. ${r3Sentence} Danach folgt Kontext.`, embedding: [0.98, 0.2, 0]
    })
  ];
  const { results, truncated } = searchKnowledgeChunks([1, 0, 0], chunks, {
    minSimilarity: 0.5,
    topK: 3,
    maxCombinedChars: 2_000,
    queryText: "Ist DEC-006 in der RAG-Allowlist enthalten?"
  });

  assert.equal(truncated, true);
  assert.equal(results.length, 2);
  assert.equal(results[0].snippet, r1Text);
  assert.equal(results[1].snippet, r3Sentence);
  assert.equal(results[1].sourceDoc, "r3.md");
  assert.equal(results[1].section, "R3");
  assert.equal(results[1].docStatus, "Draft");
  assert.equal(results[1].docVersion, "2.0");
  assert.ok(results[0].similarity > results[1].similarity);
  assert.ok(results.reduce((sum, result) => sum + result.snippet.length, 0) <= 2_000);
});

test("does not add a later sentence that is less relevant than an existing sentence", () => {
  const chunks = [
    chunk({ sourceDoc: "r1.md", text: "DEC-006 ist in der Allowlist enthalten. ".padEnd(1_600, "x"), embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "r2.md", text: "Zu grosser Treffer. ".padEnd(600, "y"), embedding: [0.99, 0.1, 0] }),
    chunk({ sourceDoc: "r3.md", text: "DEC-006 wurde erwähnt.", embedding: [0.98, 0.2, 0] })
  ];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, {
    minSimilarity: 0.5, topK: 3, maxCombinedChars: 2_000,
    queryText: "Ist DEC-006 in der Allowlist enthalten?"
  });
  assert.deepEqual(results.map((result) => result.sourceDoc), ["r1.md"]);
});

test("does not add a tied later sentence over the already selected higher retrieval rank", () => {
  const chunks = [
    chunk({ sourceDoc: "r1.md", text: "DEC-006 ist dokumentiert. ".padEnd(1_600, "x"), embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "r2.md", text: "Zu grosser Treffer. ".padEnd(600, "y"), embedding: [0.99, 0.1, 0] }),
    chunk({ sourceDoc: "r3.md", text: "DEC-006 bleibt dokumentiert.", embedding: [0.98, 0.2, 0] })
  ];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, {
    minSimilarity: 0.5, topK: 3, maxCombinedChars: 2_000,
    queryText: "Ist DEC-006 dokumentiert?"
  });
  assert.deepEqual(results.map((result) => result.sourceDoc), ["r1.md"]);
});

test("adds at most one diversity sentence and keeps the higher-ranked candidate on a tie", () => {
  const chunks = [
    chunk({ sourceDoc: "r1.md", text: "Allgemeiner Kontext. ".padEnd(1_600, "x"), embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "r2.md", text: "DEC-006 ist in der Allowlist enthalten. ".padEnd(600, "y"), embedding: [0.99, 0.1, 0] }),
    chunk({ sourceDoc: "r3.md", text: "DEC-006 bleibt in der Allowlist enthalten.", embedding: [0.98, 0.2, 0] })
  ];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, {
    minSimilarity: 0.5, topK: 3, maxCombinedChars: 2_000,
    queryText: "Ist DEC-006 in der Allowlist enthalten?"
  });
  assert.equal(results.length, 2);
  assert.equal(results[1].sourceDoc, "r2.md");
  assert.equal(results[1].snippet, "DEC-006 ist in der Allowlist enthalten.");
});

test("enforces both remaining budget and the 96-character diversity limit", () => {
  const tooLongSentence = `DEC-006 ist in der Allowlist enthalten und ${"sehr ".repeat(15)}ausführlich dokumentiert.`;
  assert.ok(tooLongSentence.length > 96);
  const longCandidate = [
    chunk({ sourceDoc: "r1.md", text: "Kontext. ".padEnd(1_600, "x"), embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "r2.md", text: "Zu gross. ".padEnd(600, "y"), embedding: [0.99, 0.1, 0] }),
    chunk({ sourceDoc: "r3.md", text: tooLongSentence, embedding: [0.98, 0.2, 0] })
  ];
  const noLongResult = searchKnowledgeChunks([1, 0, 0], longCandidate, {
    minSimilarity: 0.5, topK: 3, maxCombinedChars: 2_000,
    queryText: "Ist DEC-006 in der Allowlist enthalten?"
  });
  assert.deepEqual(noLongResult.results.map((result) => result.sourceDoc), ["r1.md"]);

  const noRemainingBudget = searchKnowledgeChunks([1, 0, 0], [
    chunk({ sourceDoc: "r1.md", text: "Kontext. ".padEnd(1_950, "x"), embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "r2.md", text: "Zu gross. ".padEnd(100, "y"), embedding: [0.99, 0.1, 0] }),
    chunk({
      sourceDoc: "r3.md",
      text: "Die Allowlist enthält **10 Dokumente einschließlich DEC-006**.",
      embedding: [0.98, 0.2, 0]
    })
  ], {
    minSimilarity: 0.5, topK: 3, maxCombinedChars: 2_000,
    queryText: "Ist DEC-006 in der Allowlist enthalten?"
  });
  assert.deepEqual(noRemainingBudget.results.map((result) => result.sourceDoc), ["r1.md"]);
  assert.ok(noRemainingBudget.results.reduce((sum, result) => sum + result.snippet.length, 0) <= 2_000);
});

test("keeps a date inside one complete diversity sentence", () => {
  const sentence = "Am 11.08.2026 ist DEC-006 in der Allowlist enthalten.";
  const chunks = [
    chunk({ sourceDoc: "r1.md", text: "Kontext. ".padEnd(1_600, "x"), embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "r2.md", text: "Zu gross. ".padEnd(600, "y"), embedding: [0.99, 0.1, 0] }),
    chunk({ sourceDoc: "r3.md", text: sentence, embedding: [0.98, 0.2, 0] })
  ];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, {
    minSimilarity: 0.5, topK: 3, maxCombinedChars: 2_000,
    queryText: "Ist DEC-006 am 11.08.2026 in der Allowlist enthalten?"
  });
  assert.equal(results[1].snippet, sentence);
});

test("does not treat an abbreviation fragment as a complete diversity sentence", () => {
  const chunks = [
    chunk({ sourceDoc: "r1.md", text: "Kontext. ".padEnd(1_600, "x"), embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "r2.md", text: "Zu gross. ".padEnd(600, "y"), embedding: [0.99, 0.1, 0] }),
    chunk({ sourceDoc: "r3.md", text: "Die Qualifikation ist z. B. dokumentiert.", embedding: [0.98, 0.2, 0] })
  ];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, {
    minSimilarity: 0.5, topK: 3, maxCombinedChars: 2_000,
    queryText: "Ist B dokumentiert?"
  });
  assert.deepEqual(results.map((result) => result.sourceDoc), ["r1.md"]);
});

test("rejects incomplete Markdown and code fragments as diversity sentences", () => {
  const chunks = [
    chunk({ sourceDoc: "r1.md", text: "Kontext. ".padEnd(1_600, "x"), embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "r2.md", text: "Die Allowlist enthält **DEC-006. ".padEnd(600, "y"), embedding: [0.99, 0.1, 0] }),
    chunk({ sourceDoc: "r3.md", text: "Die Allowlist enthält `DEC-006.", embedding: [0.98, 0.2, 0] })
  ];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, {
    minSimilarity: 0.5, topK: 3, maxCombinedChars: 2_000,
    queryText: "Ist DEC-006 in der Allowlist enthalten?"
  });
  assert.deepEqual(results.map((result) => result.sourceDoc), ["r1.md"]);
});

test("keeps a negation inside its complete diversity sentence", () => {
  const sentence = "DEC-006 ist nicht aus der Allowlist ausgeschlossen.";
  const chunks = [
    chunk({ sourceDoc: "r1.md", text: "Kontext. ".padEnd(1_600, "x"), embedding: [1, 0, 0] }),
    chunk({ sourceDoc: "r2.md", text: "Zu gross. ".padEnd(600, "y"), embedding: [0.99, 0.1, 0] }),
    chunk({ sourceDoc: "r3.md", text: sentence, embedding: [0.98, 0.2, 0] })
  ];
  const { results } = searchKnowledgeChunks([1, 0, 0], chunks, {
    minSimilarity: 0.5, topK: 3, maxCombinedChars: 2_000,
    queryText: "Ist DEC-006 aus der Allowlist ausgeschlossen?"
  });
  assert.equal(results[1].snippet, sentence);
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
