import test from "node:test";
import assert from "node:assert/strict";
import { createMockAdapter, isMockSimulationMode } from "../orchestrator/mock-adapter.js";

test("Mock adapter succeeds without external execution", async () => {
  const adapter = createMockAdapter({ stepDelayMs: 1 });
  const result = await adapter.run({ task: "Analyse", runId: "run-test", simulationMode: "success" });
  assert.equal(result.exitCode, 0);
  assert.match(result.resultSummary, /kein externes Modell/i);
  assert.deepEqual(result.events.map((event) => event.phase), ["analysis_started", "route_selected", "processing", "result_created"]);
});

test("Mock adapter simulates a controlled failure", async () => {
  const adapter = createMockAdapter({ stepDelayMs: 1 });
  const result = await adapter.run({ task: "Analyse", runId: "run-test", simulationMode: "failure" });
  assert.equal(result.exitCode, 1);
  assert.equal(result.resultSummary, null);
  assert.match(result.stderr, /simulated/i);
});

test("Mock adapter accepts only allowlisted modes and obeys abort", async () => {
  assert.equal(isMockSimulationMode("success"), true);
  assert.equal(isMockSimulationMode("arbitrary-command"), false);
  const adapter = createMockAdapter({ stepDelayMs: 5 });
  const controller = new AbortController();
  const pending = adapter.run({ task: "Analyse", runId: "run-test", simulationMode: "timeout", signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
