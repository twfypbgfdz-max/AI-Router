import test from "node:test";
import assert from "node:assert/strict";
import { normalizeForSpeech } from "../orchestrator/jarvis-speak-normalize.js";

test("removes [K#] source markers, including multiple in one sentence", () => {
  const text = "Laut [K1] gilt das, ergänzt durch [K2] und [K12].";
  const result = normalizeForSpeech(text);
  assert.ok(!result.includes("[K1]"));
  assert.ok(!result.includes("[K2]"));
  assert.ok(!result.includes("[K12]"));
  assert.equal(result, "Laut gilt das, ergänzt durch und.");
});

test("removes a relative vault path in the DEC-006 format", () => {
  const text = "Siehe 10_Apps/90_Entscheidungen/DEC-006-Felix-Core-Vertragsebene.md für Details.";
  const result = normalizeForSpeech(text);
  assert.ok(!result.includes(".md"));
  assert.equal(result, "Siehe für Details.");
});

test("removes a relative vault path with only one path segment", () => {
  const text = "Dokumentiert in 90_System/Profil.md.";
  const result = normalizeForSpeech(text);
  assert.equal(result, "Dokumentiert in.");
});

test("does not remove a path-like segment that does not end in .md", () => {
  const text = "Der Ordner 10_Apps/90_Entscheidungen enthält mehrere Dateien.";
  const result = normalizeForSpeech(text);
  assert.ok(result.includes("10_Apps/90_Entscheidungen"));
});

test("does not remove a bare .md filename without a path segment", () => {
  // Deliberately out of scope (documented limitation): at least one "/" is
  // required, so a bare filename alone is left untouched.
  const text = "Siehe DEC-006.md für Details.";
  const result = normalizeForSpeech(text);
  assert.ok(result.includes("DEC-006.md"));
});

test("normal answer text without markers or paths is unchanged", () => {
  const text = "Dein Fokus heute ist Plateau-Brecher testen.";
  assert.equal(normalizeForSpeech(text), text);
});

test("collapses whitespace and punctuation gaps left behind by removal", () => {
  const text = "Dies gilt [K1]  laut Quelle,  und  weiter.";
  const result = normalizeForSpeech(text);
  assert.ok(!result.includes("  "));
  assert.equal(result, "Dies gilt laut Quelle, und weiter.");
});

test("a marker-only text falls back to the original instead of sending empty", () => {
  const text = "[K1]";
  assert.equal(normalizeForSpeech(text), "[K1]");
});

test("null/undefined/empty input never throws and returns a string", () => {
  assert.equal(normalizeForSpeech(null), "");
  assert.equal(normalizeForSpeech(undefined), "");
  assert.equal(normalizeForSpeech(""), "");
});

test("is idempotent: applying it twice yields the same result as once", () => {
  const text = "Laut [K1] steht das in 10_Apps/90_Entscheidungen/DEC-006-Felix-Core-Vertragsebene.md.";
  const once = normalizeForSpeech(text);
  const twice = normalizeForSpeech(once);
  assert.equal(once, twice);
});
