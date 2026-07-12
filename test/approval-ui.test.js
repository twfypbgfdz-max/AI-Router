import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const file = path.resolve("01_APP", "tests", "ai-router-v0_8-test.html");

test("v0.8 UI exposes only explicit run-bound approval controls", async () => {
  const html = await fs.readFile(file, "utf8");
  assert.match(html, /Freigabeentscheidung/);
  assert.match(html, /\/api\/runs\/.*\/approval/);
  assert.match(html, /decisionNote/);
  assert.match(html, /Freigabe ablehnen/);
  assert.match(html, /sicher simulieren/);
  assert.equal(html.includes("innerHTML"), false);
});
