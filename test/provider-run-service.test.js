import test from "node:test";
import assert from "node:assert/strict";
import { createMockAdapter } from "../orchestrator/mock-adapter.js";
import { RunService } from "../orchestrator/run-service.js";
import { projectRunSummary } from "../orchestrator/run-summary.js";

const git = { captureGitState: async () => ({ repository: "x", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" }), compareGitState: () => ({ safe: true, changed: [] }) };
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "awaiting_approval"]);
async function waitFor(service, runId, maximumMs = 6_000) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) { const run = service.get(runId); if (terminal.has(run?.status)) return run; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("run did not finish");
}
function service(stepDelayMs = 1) { return new RunService({ adapters: { mock: createMockAdapter({ stepDelayMs }) }, git, persist: async () => {}, publish: async () => {} }); }

test("a specialist_chain run assigns providers per role and produces a safe synthesis, fully simulated", async () => {
  const s = service();
  const created = await s.create({ task: "Analysiere den Code im Repository vollstaendig und systematisch", adapter: "mock", simulationMode: "success", options: { providerProfile: "specialist_chain" } });
  const run = await waitFor(s, created.runId);
  assert.equal(run.status, "succeeded");
  assert.equal(run.providerWorkflowProfile, "specialist_chain");
  assert.equal(run.providerRuntime.realLocalAdapterUsed, false);
  assert.ok(run.providerRuntime.providersUsed.includes("claude-simulated"));
  assert.ok(run.providerSynthesis && run.providerSynthesis.agreements.length >= 1);
});

test("a manual simulated provider run succeeds and never claims real external execution", async () => {
  const s = service();
  const created = await s.create({ task: "Erstelle ein Konzept", adapter: "mock", simulationMode: "success", requestedProvider: "claude-simulated" });
  const run = await waitFor(s, created.runId);
  assert.equal(run.status, "succeeded");
  assert.equal(run.providerPlan.selectedProviderId, "claude-simulated");
  assert.match(run.resultSummary, /Simulation/i);
});

test("provider run summaries carry only bounded provider metadata, no raw provider output", () => {
  const summary = projectRunSummary({
    runId: "r", status: "succeeded", adapter: "mock",
    providerPlan: { selectedProviderId: "claude-simulated", selectedModelId: "claude-general-sim", selectionMode: "manual", warnings: [], reasoning: "PRIVATE REASONING TEXT" },
    providerWorkflowProfile: "specialist_chain",
    providerRuntime: { providersUsed: ["claude-simulated", "mock-local"], realLocalAdapterUsed: false }
  });
  assert.equal(summary.selectedProviderId, "claude-simulated");
  assert.equal(summary.providerCount, 2);
  assert.equal(summary.simulatedProviderCount, 2);
  assert.equal(summary.realLocalAdapterUsed, false);
  assert.equal(JSON.stringify(summary).includes("PRIVATE REASONING"), false);
});

test("old runs without a provider layer resolve to safe defaults", () => {
  const summary = projectRunSummary({ runId: "old", status: "succeeded", adapter: "mock", routePlan: { risk: "R0" } });
  assert.equal(summary.selectedProviderId, null);
  assert.equal(summary.providerWorkflowProfile, null);
  assert.deepEqual(summary.providersUsed, []);
  assert.equal(summary.providerCount, 0);
  assert.equal(summary.realLocalAdapterUsed, false);
  assert.equal(summary.providerFallbackUsed, false);
});

test("a technical provider failure retries exactly once, then succeeds", async () => {
  const s = service();
  const created = await s.create({ task: "Erstelle ein Konzept", adapter: "mock", simulationMode: "failure_once", requestedProvider: "openai-simulated" });
  const run = await waitFor(s, created.runId);
  assert.equal(run.status, "succeeded");
  assert.equal(run.retry.count, 1);
});

test("a provider timeout ends timed_out without an illegal retry", { timeout: 6_000 }, async () => {
  const s = service(40); // executor waits stepDelayMs*100 = 4000ms > the 3000ms mock timeout
  const created = await s.create({ task: "Erstelle ein Konzept", adapter: "mock", simulationMode: "timeout", requestedProvider: "openai-simulated" });
  const run = await waitFor(s, created.runId);
  assert.equal(run.status, "timed_out");
  assert.equal(run.retry.count, 0);
});

test("the approval gate is never bypassed by a manual provider or profile", async () => {
  const s = service();
  const created = await s.create({ task: "Bitte lösche die Datei config.json", adapter: "mock", requestedProvider: "claude-simulated", options: { providerProfile: "specialist_chain" } });
  const run = await waitFor(s, created.runId);
  assert.equal(run.status, "awaiting_approval");
  assert.equal(run.providerPlan.selectedProviderId, "mock-local");
  assert.equal(run.providerWorkflowProfile, "single_provider");
  assert.equal(run.adapter, "mock");
  assert.match(run.resultSummary, /nicht ausgeführt/i);
});
