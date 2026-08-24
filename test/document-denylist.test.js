import test from "node:test";
import assert from "node:assert/strict";
import { isDeniedPath } from "../orchestrator/knowledge/document-denylist.js";

test("denies each configured prefix", () => {
  assert.equal(isDeniedPath("60_Finanzen/Geldanlage.md"), true);
  assert.equal(isDeniedPath("00_Inbox/Session-Rohdaten.md"), true);
  assert.equal(isDeniedPath(".obsidian/workspace.json"), true);
  assert.equal(isDeniedPath(".claudian/sessions/x.json"), true);
  assert.equal(isDeniedPath(".git/config"), true);
  assert.equal(isDeniedPath(".claude/settings.json"), true);
});

test("denies Windows path prefixes case-insensitively", () => {
  assert.equal(isDeniedPath("60_Finanzen/Geldanlage.md"), true);
  assert.equal(isDeniedPath("60_finanzen/Geldanlage.md"), true);
  assert.equal(isDeniedPath("60_FiNaNzEn/Geldanlage.md"), true);
});

test("allows a path outside every denied prefix", () => {
  assert.equal(isDeniedPath("10_Apps/90_Entscheidungen/DEC-002.md"), false);
});

test("normalizes backslashes before matching", () => {
  assert.equal(isDeniedPath("60_Finanzen\\Geldanlage.md"), true);
});

test("rejects non-string input as denied (fail closed)", () => {
  assert.equal(isDeniedPath(undefined), true);
  assert.equal(isDeniedPath(""), true);
});
