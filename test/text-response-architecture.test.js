import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "api", "router", "respond.js");
const forbiddenImportFragments = [
  "run-service",
  "workflow-engine",
  "codex-adapter",
  "run-store",
  "execution-store",
  "child_process",
  "node:child_process",
  "node:fs",
  "node:fs/promises"
];

function importsFor(file) {
  const source = fs.readFileSync(file, "utf8");
  const specifiers = [];
  const pattern = /(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"]+\s+from\s+)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  return { source, specifiers };
}

function reachableFiles(start) {
  const visited = new Set();
  const queue = [start];
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const { specifiers } = importsFor(file);
    for (const specifier of specifiers) {
      for (const fragment of forbiddenImportFragments) {
        assert.equal(specifier.includes(fragment), false, `${path.relative(root, file)} imports ${specifier}`);
      }
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      assert.equal(resolved.startsWith(root), true, "response import must stay inside AI-Router");
      queue.push(resolved);
    }
  }
  return visited;
}

test("/api/router/respond has a separate import graph with no legacy execution or file-writing modules", () => {
  const files = reachableFiles(entry);
  const names = [...files].map((file) => path.relative(root, file).replaceAll("\\", "/"));
  assert.ok(names.includes("orchestrator/text-response-handler.js"));
  assert.ok(names.includes("orchestrator/provider-adapters/openai-text.js"));
  assert.equal(names.some((name) => name.includes("workflow-engine")), false);
  assert.equal(names.some((name) => name.includes("run-service")), false);
  assert.equal(names.some((name) => name.includes("codex-adapter")), false);
});

test("the endpoint is non-streaming and its Vercel duration exceeds the router total timeout", async () => {
  const module = await import("../api/router/respond.js");
  assert.equal(typeof module.default, "function");
  assert.equal(module.config.maxDuration, 25);
  const adapterSource = fs.readFileSync(path.join(root, "orchestrator", "provider-adapters", "openai-text.js"), "utf8");
  assert.match(adapterSource, /https:\/\/api\.openai\.com\/v1\/responses/);
  assert.equal(/\bstream\s*:/.test(adapterSource), false);
});
