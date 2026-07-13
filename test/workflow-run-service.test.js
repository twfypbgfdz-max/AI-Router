import test from "node:test";
import assert from "node:assert/strict";
import { createMockAdapter } from "../orchestrator/mock-adapter.js";
import { RunService } from "../orchestrator/run-service.js";

const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "awaiting_approval"]);
async function waitFor(service, runId, statuses = terminal, maximumMs = 5_000) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    const run = service.get(runId);
    if (statuses.has(run?.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Workflow run did not finish.");
}

function serviceFixture({ stepDelayMs = 1 } = {}) {
  const snapshots = [];
  const adapter = createMockAdapter({ stepDelayMs });
  const service = new RunService({
    adapters: { mock: adapter },
    git: { captureGitState: async () => { throw new Error("Git must not run for mock workflow."); }, compareGitState: () => { throw new Error("Git must not run for mock workflow."); } },
    persist: async (run) => { snapshots.push(structuredClone(run)); },
    publish: async () => {}
  });
  return { service, snapshots };
}

test("direct, plan_execute and plan_execute_review run fixed roles in order", async () => {
  const cases = [
    ["Sortiere meine Einkaufsliste", "direct", ["executor", "synthesizer"]],
    ["Erstelle ein Konzept für einen Text", "plan_execute", ["planner", "executor", "synthesizer"]],
    ["Analysiere diesen wichtigen Code ohne Änderungen", "plan_execute_review", ["planner", "executor", "reviewer", "synthesizer"]]
  ];
  for (const [task, type, roles] of cases) {
    const fixture = serviceFixture();
    const created = await fixture.service.create({ task, adapter: "mock", simulationMode: "success" });
    const run = await waitFor(fixture.service, created.runId);
    assert.equal(run.status, "succeeded", task);
    assert.equal(run.workflow.type, type, task);
    assert.deepEqual(run.workflow.steps.map((step) => step.role), roles, task);
    assert.ok(run.workflow.steps.every((step) => step.status === "succeeded"), task);
    assert.equal(run.workflow.status, "succeeded", task);
    assert.equal(run.workflow.steps.filter((step) => step.status === "running").length, 0);
    assert.match(run.resultSummary, /Simulation/i);
  }
});

test("executor failure stops reviewer and synthesis and aligns final status", async () => {
  const fixture = serviceFixture();
  const created = await fixture.service.create({ task: "Analysiere diesen wichtigen Code ohne Änderungen", adapter: "mock", simulationMode: "failure_executor" });
  const run = await waitFor(fixture.service, created.runId);
  assert.equal(run.status, "failed");
  assert.equal(run.workflow.status, "failed");
  assert.equal(run.workflow.steps.find((step) => step.role === "planner").status, "succeeded");
  assert.equal(run.workflow.steps.find((step) => step.role === "executor").status, "failed");
  assert.equal(run.workflow.steps.find((step) => step.role === "reviewer").status, "skipped");
  assert.equal(run.workflow.steps.find((step) => step.role === "synthesizer").status, "skipped");
});

test("reviewer failure stops synthesis and aligns final status", async () => {
  const fixture = serviceFixture();
  const created = await fixture.service.create({ task: "Analysiere diesen wichtigen Code ohne Änderungen", adapter: "mock", simulationMode: "failure_reviewer" });
  const run = await waitFor(fixture.service, created.runId);
  assert.equal(run.status, "failed");
  assert.equal(run.workflow.status, "failed");
  assert.equal(run.workflow.steps.find((step) => step.role === "executor").status, "succeeded");
  assert.equal(run.workflow.steps.find((step) => step.role === "reviewer").status, "failed");
  assert.equal(run.workflow.steps.find((step) => step.role === "synthesizer").status, "skipped");
});

test("timeout fails the current step and ends run timed_out", { timeout: 5_000 }, async () => {
  const fixture = serviceFixture({ stepDelayMs: 40 });
  const created = await fixture.service.create({ task: "Erstelle ein Konzept für einen Text", adapter: "mock", simulationMode: "timeout" });
  const run = await waitFor(fixture.service, created.runId, terminal, 5_000);
  assert.equal(run.status, "timed_out");
  assert.equal(run.workflow.status, "failed");
  assert.equal(run.workflow.steps.find((step) => step.role === "executor").status, "failed");
  assert.ok(run.workflow.steps.filter((step) => step.status === "running").length === 0);
});

test("cancel stops current and open workflow steps", async () => {
  const fixture = serviceFixture({ stepDelayMs: 80 });
  const created = await fixture.service.create({ task: "Analysiere diesen wichtigen Code ohne Änderungen", adapter: "mock", simulationMode: "success" });
  const deadline = Date.now() + 1_000;
  while (!fixture.service.get(created.runId).workflow.currentStep && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await fixture.service.cancel(created.runId);
  const run = await waitFor(fixture.service, created.runId);
  assert.equal(run.status, "cancelled");
  assert.equal(run.workflow.status, "cancelled");
  assert.equal(run.workflow.steps.some((step) => step.status === "running"), false);
  assert.ok(run.workflow.steps.some((step) => step.status === "cancelled"));
});

test("client cannot inject workflow type, roles or order", async () => {
  const fixture = serviceFixture();
  const created = await fixture.service.create({
    task: "Analysiere diesen wichtigen Code ohne Änderungen",
    adapter: "mock",
    simulationMode: "success",
    workflowType: "direct",
    roles: ["hacker"],
    workflow: { type: "custom", steps: [] }
  });
  const run = await waitFor(fixture.service, created.runId);
  assert.equal(run.workflow.type, "plan_execute_review");
  assert.deepEqual(run.workflow.steps.map((step) => step.role), ["planner", "executor", "reviewer", "synthesizer"]);
});

test("run-store snapshots contain bounded workflow metadata after every step", async () => {
  const fixture = serviceFixture();
  const created = await fixture.service.create({ task: "Erstelle ein Konzept für einen Text", adapter: "mock", simulationMode: "success" });
  const run = await waitFor(fixture.service, created.runId);
  assert.equal(run.status, "succeeded");
  assert.ok(fixture.snapshots.some((snapshot) => snapshot.workflow?.steps.some((step) => step.status === "running")));
  const stored = fixture.snapshots.at(-1).workflow;
  assert.equal(stored.status, "succeeded");
  assert.ok(stored.steps.every((step) => Object.keys(step).every((key) => ["id", "role", "status", "startedAt", "finishedAt", "summary", "errorSummary"].includes(key))));
  assert.ok(stored.steps.every((step) => step.summary.length <= 500));
});
