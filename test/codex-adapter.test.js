import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildCodexArgs, terminateProcessTree } from "../orchestrator/codex-adapter.js";

test("Codex arguments are fixed to read-only mode", () => { const args = buildCodexArgs("C:\\repo"); assert.ok(args.includes("read-only")); assert.ok(args.includes("--json")); assert.ok(!args.includes("--search")); assert.ok(!args.includes("--add-dir")); assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox")); });

function fakeProcess(properties = {}) { const process = new EventEmitter(); return Object.assign(process, { pid: 42, exitCode: null, killed: false, kill() { this.killed = true; } }, properties); }

test("taskkill non-zero exit falls back without hanging", async () => {
  const child = fakeProcess();
  const killer = fakeProcess({ pid: 99 });
  const resultPromise = terminateProcessTree(child, { spawnImpl: () => killer, timeoutMs: 50 });
  killer.emit("close", 5);
  assert.equal((await resultPromise).outcome, "taskkill_exit_5");
  assert.equal(child.killed, true);
});

test("hanging taskkill is bounded and falls back", async () => {
  const child = fakeProcess();
  const killer = fakeProcess({ pid: 99 });
  const result = await terminateProcessTree(child, { spawnImpl: () => killer, timeoutMs: 5 });
  assert.equal(result.outcome, "taskkill_timeout");
  assert.equal(killer.killed, true);
  assert.equal(child.killed, true);
});
