import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

test("v0.9 UI shows fixed workflow roles, errors, cancellation and approval safely", async () => {
  const html = await fs.readFile(path.resolve("01_APP", "tests", "ai-router-v0_9-test.html"), "utf8");
  for (const text of ["Planer", "Ausführer", "Prüfer", "Zusammenführung", "failure_executor", "failure_reviewer", "Workflow abbrechen", "Freigabeentscheidung"]) assert.match(html, new RegExp(text));
  assert.equal(html.includes("innerHTML"), false);
  assert.match(html, /textContent/);
});
