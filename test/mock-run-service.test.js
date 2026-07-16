import test from "node:test";
import assert from "node:assert/strict";
import { createMockAdapter } from "../orchestrator/mock-adapter.js";
import { RunService } from "../orchestrator/run-service.js";
import { projectCockpitStatus } from "../orchestrator/cockpit-status.js";

const state = { repository: "C:\\repo", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" };
const git = { captureGitState: async () => ({ ...state }), compareGitState: () => ({ safe: true, changed: [] }) };
const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "awaiting_approval"]);

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
  assert.equal(states[0], "created");
  assert.deepEqual([...new Set(states)], ["created", "validating", "queued", "running", "succeeded"]);
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
  assert.match(run.errorSummary, /timed out/i);
});

test("R4 task stops awaiting approval without starting any adapter", async () => {
  let codexStarts = 0;
  let mockStarts = 0;
  const mock = createMockAdapter({ stepDelayMs: 1 });
  const service = new RunService({
    adapters: {
      mock: { run(options) { mockStarts += 1; return mock.run(options); } },
      "codex-cli": { resolveExecutable: async () => "codex", run: async () => { codexStarts += 1; return {}; } }
    },
    git,
    persist: async () => {},
    publish: async () => {}
  });
  const created = await service.create({ task: "Dateien löschen", adapter: "codex-cli" });
  const run = await waitForTerminal(service, created.runId);
  assert.equal(run.status, "awaiting_approval");
  assert.equal(run.adapter, "mock");
  assert.equal(run.routePlan.executionAdapter, "mock");
  assert.equal(run.routePlan.risk, "R4");
  assert.equal(run.routePlan.approvalRequired, true);
  assert.equal(codexStarts, 0);
  assert.equal(mockStarts, 0);
  assert.match(run.resultSummary, /nicht ausgeführt/i);
  const cockpit = projectCockpitStatus(run);
  assert.equal(cockpit.lastRunStatus, "awaiting_approval");
  assert.equal(cockpit.activeOrWaitingRuns, 1);
});
