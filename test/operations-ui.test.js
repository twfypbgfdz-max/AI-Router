import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

test("v0.12 UI exposes the operations overview and run history controls", async () => {
  const html = await fs.readFile(path.resolve("01_APP", "tests", "ai-router-v0_12-test.html"), "utf8");
  for (const text of ["Betriebsübersicht", "Run-Historie", "Codex-Verfügbarkeit erneut prüfen", "Mock verfügbar", "Codex read-only", "Aktive Runs", "Wartende Freigaben", "Letzter Erfolg", "Letzter sicherer Fehler"]) {
    assert.match(html, new RegExp(text));
  }
  // Uses the new safe operational endpoints.
  for (const endpoint of ["/api/health", "/api/history", "/api/adapters/check"]) {
    assert.ok(html.includes(endpoint), `missing endpoint ${endpoint}`);
  }
});

test("v0.12 UI maps technical states to safe German labels and safe error explanations", async () => {
  const html = await fs.readFile(path.resolve("01_APP", "tests", "ai-router-v0_12-test.html"), "utf8");
  for (const text of ["Zeitüberschreitung", "Abgebrochen", "Wartet auf Freigabe", "Technischer Wiederholungsversuch", "READ_ONLY_VIOLATION_DETECTED", "Nicht unterstützt"]) {
    assert.match(html, new RegExp(text));
  }
});

test("v0.12 UI never renders raw HTML and keeps status values internal", async () => {
  const html = await fs.readFile(path.resolve("01_APP", "tests", "ai-router-v0_12-test.html"), "utf8");
  assert.equal(html.includes(".innerHTML=data"), false);
  assert.equal(html.includes("stdout"), false);
  assert.equal(html.includes("stderr"), false);
  assert.match(html, /textContent/);
});
