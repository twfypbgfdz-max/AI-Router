import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadVaultDocument } from "../orchestrator/knowledge/document-loader.js";
import { RagError } from "../orchestrator/knowledge/rag-error.js";

function tempVaultWithFile(relativePath, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-loader-"));
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  return dir;
}

test("extracts frontmatter and body separately", () => {
  const vaultRoot = tempVaultWithFile("10_Apps/doc.md", "---\ntype: decision\nstatus: Accepted\n---\n\n# Title\n\nBody text.");
  const document = loadVaultDocument(vaultRoot, "10_Apps/doc.md");
  assert.equal(document.frontmatter.type, "decision");
  assert.equal(document.frontmatter.status, "Accepted");
  assert.ok(document.body.includes("Body text."));
  assert.ok(!document.body.includes("type: decision"));
});

test("content hash is stable for identical content", () => {
  const vaultRoot = tempVaultWithFile("10_Apps/doc.md", "---\ntype: knowledge\n---\n\nSame content.");
  const first = loadVaultDocument(vaultRoot, "10_Apps/doc.md");
  const second = loadVaultDocument(vaultRoot, "10_Apps/doc.md");
  assert.equal(first.contentHash, second.contentHash);
  assert.match(first.contentHash, /^sha256:[0-9a-f]{64}$/);
});

test("content hash changes when content changes", () => {
  const vaultRoot = tempVaultWithFile("10_Apps/doc.md", "---\ntype: knowledge\n---\n\nOriginal.");
  const before = loadVaultDocument(vaultRoot, "10_Apps/doc.md");
  fs.writeFileSync(path.join(vaultRoot, "10_Apps", "doc.md"), "---\ntype: knowledge\n---\n\nChanged.");
  const after = loadVaultDocument(vaultRoot, "10_Apps/doc.md");
  assert.notEqual(before.contentHash, after.contentHash);
});

test("missing document is reported without throwing", () => {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-loader-"));
  fs.mkdirSync(path.join(vaultRoot, "10_Apps"), { recursive: true });
  const document = loadVaultDocument(vaultRoot, "10_Apps/missing.md");
  assert.equal(document.exists, false);
});

test("oversized document throws DOCUMENT_TOO_LARGE", () => {
  const vaultRoot = tempVaultWithFile("10_Apps/big.md", "x".repeat(200_001));
  assert.throws(() => loadVaultDocument(vaultRoot, "10_Apps/big.md"), (error) => error instanceof RagError && error.code === "DOCUMENT_TOO_LARGE");
});

test("unreadable document throws DOCUMENT_UNREADABLE", () => {
  const vaultRoot = tempVaultWithFile("10_Apps/doc.md", "content");
  const readFileSync = () => {
    throw Object.assign(new Error("boom"), { code: "EACCES" });
  };
  assert.throws(() => loadVaultDocument(vaultRoot, "10_Apps/doc.md", { readFileSync, statSync: fs.statSync }), (error) => error.code === "DOCUMENT_UNREADABLE");
});

test("malformed frontmatter does not crash, falls back to full body", () => {
  const vaultRoot = tempVaultWithFile("10_Apps/doc.md", "no frontmatter here\njust text");
  const document = loadVaultDocument(vaultRoot, "10_Apps/doc.md");
  assert.deepEqual(document.frontmatter, {});
  assert.ok(document.body.includes("just text"));
});
