import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAllowlist } from "../orchestrator/knowledge/document-allowlist.js";
import { RagError } from "../orchestrator/knowledge/rag-error.js";

function writeAllowlist(documents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rag-allowlist-")), "rag-allowlist.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: "1.0", vaultRootEnvVar: "AI_ROUTER_VAULT_ROOT", documents }));
  return file;
}

test("loads a valid allowlist with safe entries", () => {
  const file = writeAllowlist([{ relativePath: "10_Apps/doc.md", addedAt: "2026-07-28", addedBy: "felix" }]);
  const allowlist = loadAllowlist(file);
  assert.equal(allowlist.documents.length, 1);
  assert.equal(allowlist.rejected.length, 0);
});

test("empty allowlist loads successfully", () => {
  const file = writeAllowlist([]);
  const allowlist = loadAllowlist(file);
  assert.equal(allowlist.documents.length, 0);
});

test("drops a denied-folder entry into rejected, does not abort the load", () => {
  const file = writeAllowlist([
    { relativePath: "60_Finanzen/Geldanlage.md" },
    { relativePath: "10_Apps/doc.md" }
  ]);
  const allowlist = loadAllowlist(file);
  assert.equal(allowlist.documents.length, 1);
  assert.equal(allowlist.documents[0].relativePath, "10_Apps/doc.md");
  assert.equal(allowlist.rejected.length, 1);
  assert.equal(allowlist.rejected[0].code, "ALLOWLIST_ENTRY_DENIED");
});

test("drops a traversal entry into rejected", () => {
  const file = writeAllowlist([{ relativePath: "../outside.md" }]);
  const allowlist = loadAllowlist(file);
  assert.equal(allowlist.documents.length, 0);
  assert.equal(allowlist.rejected[0].code, "ALLOWLIST_ENTRY_UNSAFE_PATH");
});

test("drops a duplicate entry into rejected", () => {
  const file = writeAllowlist([{ relativePath: "10_Apps/doc.md" }, { relativePath: "10_Apps/doc.md" }]);
  const allowlist = loadAllowlist(file);
  assert.equal(allowlist.documents.length, 1);
  assert.equal(allowlist.rejected[0].code, "ALLOWLIST_ENTRY_DUPLICATE");
});

test("throws ALLOWLIST_INVALID for malformed JSON", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rag-allowlist-")), "bad.json");
  fs.writeFileSync(file, "{not json");
  assert.throws(() => loadAllowlist(file), (error) => error instanceof RagError && error.code === "ALLOWLIST_INVALID");
});

test("throws ALLOWLIST_INVALID for wrong schemaVersion", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rag-allowlist-")), "wrong.json");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: "9.9", documents: [] }));
  assert.throws(() => loadAllowlist(file), (error) => error.code === "ALLOWLIST_INVALID");
});

test("throws ALLOWLIST_INVALID when exceeding the maximum entry count", () => {
  const documents = Array.from({ length: 101 }, (_, i) => ({ relativePath: `10_Apps/doc-${i}.md` }));
  const file = writeAllowlist(documents);
  assert.throws(() => loadAllowlist(file), (error) => error.code === "ALLOWLIST_INVALID");
});
