import test from "node:test";
import assert from "node:assert/strict";
import { createMockAdapter } from "../orchestrator/mock-adapter.js";
import { RunService } from "../orchestrator/run-service.js";

const state = { repository: "C:\\repo", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" };
const git = { captureGitState: async () => ({ ...state }), compareGitState: () => ({ safe: true, changed: [] }) };
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

async function waitForTerminal(service, runId, maximumMs = 4_000) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    const run = service.get(runId);
    if (terminal.has(run?.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Mock run did not finish.");
}

function mockService({ adapter = createMockAdapter({ stepDelayMs: 1 }), states = [] } = {}) {
  return new RunService({ adapters: { mock: adapter }, git, persist: async (run) => { states.push(run.status); }, publish: async () => {} });
}

test("Mock run reuses created, validating, queued, running and succeeded states", async () => {
  const states = [];
  const service = mockService({ states });
  const created = await service.create({ task: "Simulate success", adapter: "mock", simulationMode: "success" });
  const run = await waitForTerminal(service, created.runId);
  assert.equal(run.status, "succeeded");
  assert.deepEqual(states, ["created", "validating", "queued", "running", "succeeded"]);
  assert.equal(run.adapter, "mock");
});

test("Mock failure and cancellation have controlled terminal states", async () => {
  const service = mockService({ adapter: createMockAdapter({ stepDelayMs: 10 }) });
  const failure = await service.create({ task: "Simulate failure", adapter: "mock", simulationMode: "failure" });
  assert.equal((await waitForTerminal(service, failure.runId)).status, "failed");

  const cancelled = await service.create({ task: "Simulate cancellation", adapter: "mock", simulationMode: "timeout" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await service.cancel(cancelled.runId);
  assert.equal((await waitForTerminal(service, cancelled.runId)).status, "cancelled");
});

test("Mock timeout terminates as timed_out after its fixed test deadline", { timeout: 5_000 }, async () => {
  const adapter = { run: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) };
  const service = mockService({ adapter });
  const created = await service.create({ task: "Simulate timeout", adapter: "mock", simulationMode: "timeout" });
  const run = await waitForTerminal(service, created.runId);
  assert.equal(run.status, "timed_out");
  assert.match(run.errorSummary, /timeout/i);
});
