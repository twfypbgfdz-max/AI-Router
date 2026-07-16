import test from "node:test";
import assert from "node:assert/strict";
import { createMockAdapter } from "../orchestrator/mock-adapter.js";
import { RunService } from "../orchestrator/run-service.js";

const gitState = { repository: "C:\\repo", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" };
const git = { captureGitState: async () => ({ ...gitState }), compareGitState: () => ({ safe: true, changed: [] }) };
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "awaiting_approval"]);

async function waitFor(service, runId, maximumMs = 4_000) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    const run = service.get(runId);
    if (terminal.has(run?.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Run did not finish.");
}

function serviceWithEvents({ stepDelayMs = 40 } = {}) {
  const events = [];
  const service = new RunService({
    adapters: { mock: createMockAdapter({ stepDelayMs }) },
    git,
    persist: async () => {}, publish: async () => {},
    logger: { log: async (entry) => { events.push(entry.event); } }
  });
  return { service, events };
}

test("cancel returns null for unknown and already finished runs (idempotent)", async () => {
  const { service } = serviceWithEvents({ stepDelayMs: 1 });
  assert.equal(await service.cancel("run_unknown"), null);
  const created = await service.create({ task: "Sortiere meine Einkaufsliste", adapter: "mock", simulationMode: "success" });
  const finished = await waitFor(service, created.runId);
  assert.equal(finished.status, "succeeded");
  assert.equal(await service.cancel(created.runId), null, "a finished run cannot be cancelled");
});

test("cancelling a running mock run ends as cancelled, does not retry and logs cancel events", async () => {
  const { service, events } = serviceWithEvents({ stepDelayMs: 60 });
  const created = await service.create({ task: "Analysiere diesen wichtigen Code ohne Änderungen", adapter: "mock", simulationMode: "success" });
  const deadline = Date.now() + 1_000;
  while (!service.get(created.runId).workflow.currentStep && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  await service.cancel(created.runId);
  const run = await waitFor(service, created.runId);
  assert.equal(run.status, "cancelled");
  assert.equal(run.retry.count, 0, "cancellation must not trigger a retry");
  assert.ok(events.includes("run_cancel_requested"));
  assert.ok(events.includes("run_cancel_completed"));
});

test("a second cancel after cancellation is a safe no-op", async () => {
  const { service } = serviceWithEvents({ stepDelayMs: 60 });
  const created = await service.create({ task: "Analysiere diesen wichtigen Code ohne Änderungen", adapter: "mock", simulationMode: "success" });
  const deadline = Date.now() + 1_000;
  while (!service.get(created.runId).workflow.currentStep && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  await service.cancel(created.runId);
  await waitFor(service, created.runId);
  assert.equal(await service.cancel(created.runId), null);
  assert.equal(service.get(created.runId).status, "cancelled");
});

test("a run still completes even when the logger keeps failing", async () => {
  const service = new RunService({
    adapters: { mock: createMockAdapter({ stepDelayMs: 1 }) },
    git,
    persist: async () => {}, publish: async () => {},
    logger: { log: async () => { throw new Error("logging backend down"); } }
  });
  const created = await service.create({ task: "Sortiere meine Einkaufsliste", adapter: "mock", simulationMode: "success" });
  const run = await waitFor(service, created.runId);
  assert.equal(run.status, "succeeded");
});
