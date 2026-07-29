import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeRelativePath, resolveSafeVaultPath } from "../orchestrator/knowledge/vault-path-guard.js";
import { RagError } from "../orchestrator/knowledge/rag-error.js";

function tempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-vault-guard-"));
  fs.mkdirSync(path.join(dir, "10_Apps"), { recursive: true });
  fs.writeFileSync(path.join(dir, "10_Apps", "doc.md"), "# Doc");
  return dir;
}

test("accepts a well-formed relative markdown path", () => {
  assert.equal(assertSafeRelativePath("10_Apps/doc.md"), "10_Apps/doc.md");
});

test("rejects absolute paths", () => {
  assert.throws(() => assertSafeRelativePath("C:/Users/felil/x.md"), RagError);
  assert.throws(() => assertSafeRelativePath("/etc/x.md"), RagError);
});

test("rejects backslashes", () => {
  assert.throws(() => assertSafeRelativePath("10_Apps\\doc.md"), RagError);
});

test("rejects traversal segments", () => {
  assert.throws(() => assertSafeRelativePath("10_Apps/../../etc/passwd.md"), RagError);
  assert.throws(() => assertSafeRelativePath("../secret.md"), RagError);
});

test("rejects a denied-folder path even if otherwise well-formed", () => {
  assert.throws(() => assertSafeRelativePath("60_Finanzen/Geldanlage.md"), (error) => error.code === "ALLOWLIST_ENTRY_DENIED");
});

test("resolveSafeVaultPath resolves an existing file inside the vault root", () => {
  const vaultRoot = tempVault();
  const resolved = resolveSafeVaultPath(vaultRoot, "10_Apps/doc.md");
  assert.equal(resolved.exists, true);
  assert.equal(fs.realpathSync(resolved.absolutePath), resolved.absolutePath);
});

test("resolveSafeVaultPath reports a missing file without throwing", () => {
  const vaultRoot = tempVault();
  const resolved = resolveSafeVaultPath(vaultRoot, "10_Apps/missing.md");
  assert.equal(resolved.exists, false);
});

test("resolveSafeVaultPath rejects a symlink escaping the vault root", (t) => {
  const vaultRoot = tempVault();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-vault-outside-"));
  const outsideFile = path.join(outsideDir, "outside.md");
  fs.writeFileSync(outsideFile, "# Outside");
  const linkPath = path.join(vaultRoot, "10_Apps", "escape.md");
  try {
    fs.symlinkSync(outsideFile, linkPath, "file");
  } catch {
    t.skip("Symlink creation not permitted in this environment.");
    return;
  }
  assert.throws(() => resolveSafeVaultPath(vaultRoot, "10_Apps/escape.md"), (error) => error.code === "ALLOWLIST_ENTRY_UNSAFE_PATH");
});
