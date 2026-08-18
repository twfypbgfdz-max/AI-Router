import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeDecCoverage, DEC_DIRECTORY_RELATIVE } from "../orchestrator/knowledge/rag-dec-coverage.js";

function makeVault(files) {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-dec-coverage-vault-"));
  const decDirectory = path.join(vaultRoot, ...DEC_DIRECTORY_RELATIVE.split("/"));
  fs.mkdirSync(decDirectory, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(decDirectory, filename), content, "utf8");
  }
  return vaultRoot;
}

function decFile(id, status = "Accepted") {
  return `---\ntype: decision\nid: DEC-${id}\nversion: "1.0"\nstatus: ${status}\ndatum: 2026-08-18\n---\n\n# DEC-${id}: Test\n`;
}

function writeAllowlist(relativePaths) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rag-dec-coverage-allowlist-")), "rag-allowlist.json");
  const documents = relativePaths.map((relativePath) => ({
    relativePath,
    addedAt: "2026-08-18",
    addedBy: "felix",
    informationClass: "architecture_rule"
  }));
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: "1.0", vaultRootEnvVar: "AI_ROUTER_VAULT_ROOT", documents }));
  return file;
}

test("full coverage: every Accepted DEC is allowlisted -> PASS", () => {
  const vaultRoot = makeVault({
    "DEC-001-Rollen.md": decFile("001"),
    "DEC-002-Regeln.md": decFile("002")
  });
  const allowlistFilePath = writeAllowlist([
    `${DEC_DIRECTORY_RELATIVE}/DEC-001-Rollen.md`,
    `${DEC_DIRECTORY_RELATIVE}/DEC-002-Regeln.md`
  ]);

  const result = computeDecCoverage({ vaultRoot, allowlistFilePath });

  assert.equal(result.totalValid, 2);
  assert.equal(result.totalAllowlisted, 2);
  assert.deepEqual(result.missing, []);
  assert.equal(result.pass, true);
});

test("one missing DEC -> FAIL and names it", () => {
  const vaultRoot = makeVault({
    "DEC-001-Rollen.md": decFile("001"),
    "DEC-002-Regeln.md": decFile("002")
  });
  const allowlistFilePath = writeAllowlist([`${DEC_DIRECTORY_RELATIVE}/DEC-001-Rollen.md`]);

  const result = computeDecCoverage({ vaultRoot, allowlistFilePath });

  assert.equal(result.totalValid, 2);
  assert.equal(result.totalAllowlisted, 1);
  assert.deepEqual(result.missing, [`${DEC_DIRECTORY_RELATIVE}/DEC-002-Regeln.md`]);
  assert.equal(result.pass, false);
});

test("a superseded/draft DEC is not required to be allowlisted", () => {
  const vaultRoot = makeVault({
    "DEC-001-Rollen.md": decFile("001", "Accepted"),
    "DEC-002-Alt.md": decFile("002", "Superseded"),
    "DEC-003-Entwurf.md": decFile("003", "Draft")
  });
  const allowlistFilePath = writeAllowlist([`${DEC_DIRECTORY_RELATIVE}/DEC-001-Rollen.md`]);

  const result = computeDecCoverage({ vaultRoot, allowlistFilePath });

  assert.equal(result.totalValid, 1);
  assert.equal(result.totalAllowlisted, 1);
  assert.deepEqual(result.missing, []);
  assert.equal(result.pass, true);
});

test("unexpected non-DEC files in the folder are ignored, not treated as missing", () => {
  const vaultRoot = makeVault({
    "DEC-001-Rollen.md": decFile("001"),
    "Entscheidungslog.md": "---\ntype: decision\n---\n\n# Entscheidungslog\n",
    "README.md": "# not a decision"
  });
  const allowlistFilePath = writeAllowlist([`${DEC_DIRECTORY_RELATIVE}/DEC-001-Rollen.md`]);

  const result = computeDecCoverage({ vaultRoot, allowlistFilePath });

  assert.equal(result.totalValid, 1);
  assert.deepEqual(result.missing, []);
  assert.equal(result.pass, true);
});

test("an allowlisted entry for a non-existent or non-Accepted DEC does not fail the check", () => {
  const vaultRoot = makeVault({
    "DEC-001-Rollen.md": decFile("001", "Accepted")
  });
  const allowlistFilePath = writeAllowlist([
    `${DEC_DIRECTORY_RELATIVE}/DEC-001-Rollen.md`,
    `${DEC_DIRECTORY_RELATIVE}/DEC-099-Nicht-Vorhanden.md`
  ]);

  const result = computeDecCoverage({ vaultRoot, allowlistFilePath });

  assert.equal(result.totalValid, 1);
  assert.equal(result.pass, true);
});

test("throws when vaultRoot is missing", () => {
  assert.throws(() => computeDecCoverage({ vaultRoot: "" }));
});
