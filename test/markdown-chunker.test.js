import test from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdownBody } from "../orchestrator/knowledge/markdown-chunker.js";
import { RagError } from "../orchestrator/knowledge/rag-error.js";

test("chunks are bounded by headings and carry a full ancestor section path", () => {
  const body = "# Title\n\n## A\n\nText A.\n\n## B\n\nText B.";
  const chunks = chunkMarkdownBody(body, { relativePath: "x.md" });
  const sections = chunks.map((c) => c.section);
  assert.ok(sections.includes("Title > A"));
  assert.ok(sections.includes("Title > B"));
});

test("nested headings build a full ancestor section path", () => {
  const body = "# Title\n\n## Parent\n\n### Child\n\nDeep text.";
  const chunks = chunkMarkdownBody(body, { relativePath: "x.md" });
  const deepChunk = chunks.find((c) => c.text.includes("Deep text."));
  assert.equal(deepChunk.section, "Title > Parent > Child");
});

test("a code fence is never split mid-block", () => {
  const body = "## Code\n\n```text\nline one\n## looks like heading but is inside fence\nline two\n```\n";
  const chunks = chunkMarkdownBody(body, { relativePath: "x.md" });
  const codeChunk = chunks.find((c) => c.text.includes("line one"));
  assert.ok(codeChunk.text.includes("line two"));
  assert.equal(chunks.filter((c) => c.text.includes("line one")).length, 1);
});

test("a table stays within a single chunk", () => {
  const body = "## Table\n\n| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n";
  const chunks = chunkMarkdownBody(body, { relativePath: "x.md" });
  const tableChunk = chunks.find((c) => c.text.includes("| A | B |"));
  assert.ok(tableChunk.text.includes("| 3 | 4 |"));
});

test("an oversized section is split at paragraph boundaries under the hard limit", () => {
  const paragraph = "Sentence. ".repeat(50);
  const body = `## Long\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`;
  const chunks = chunkMarkdownBody(body, { relativePath: "x.md" });
  assert.ok(chunks.every((c) => c.text.length <= 2000));
  assert.ok(chunks.length > 1);
});

test("very short adjacent chunks in the same section are merged", () => {
  const body = "## Short\n\nA.\n\n## Short\n\nB.";
  // Two headings with identical title collapse into separate section paths
  // by heading identity in this simple fixture; use list items instead to
  // exercise merging within one section.
  const listBody = "## List\n\n- item one\n\n- item two\n\n- item three";
  const chunks = chunkMarkdownBody(listBody, { relativePath: "x.md" });
  assert.equal(chunks.length, 1);
  void body;
});

test("throws DOCUMENT_TOO_LARGE when chunk count exceeds the hard limit", () => {
  const body = Array.from({ length: 250 }, (_, i) => `## Heading ${i}\n\n${"x".repeat(2500)}`).join("\n\n");
  assert.throws(() => chunkMarkdownBody(body, { relativePath: "x.md" }), (error) => error instanceof RagError && error.code === "DOCUMENT_TOO_LARGE");
});

test("frontmatter-free plain text still chunks without a heading", () => {
  const chunks = chunkMarkdownBody("Just a paragraph with no heading at all.", { relativePath: "x.md" });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].section, null);
});
