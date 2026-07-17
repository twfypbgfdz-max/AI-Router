import test from "node:test";
import assert from "node:assert/strict";
import { projectCockpitStatus } from "../orchestrator/cockpit-status.js";
import { createMockAdapter } from "../orchestrator/mock-adapter.js";
import { RunService } from "../orchestrator/run-service.js";

const baseContext = {
  serviceStatus: "ok", activeRuns: 3, awaitingApprovalRuns: 2,
  lastSuccessfulRunAt: "2026-01-01T00:00:00.000Z", lastSafeErrorCode: "ADAPTER_FAILED",
  adapterStatus: { mock: { state: "available" }, "codex-cli": { state: "available" } },
  checkedAt: "2026-01-01T00:00:05.000Z", lastRunStatus: "succeeded"
};

test("cockpit keeps the full v0.12 contract fields unchanged", () => {
  const status = projectCockpitStatus(baseContext);
  for (const key of ["reachable", "serviceStatus", "version", "activeRuns", "awaitingApprovalRuns", "lastSuccessfulRunAt", "lastSafeErrorCode", "mockAvailable", "codexReadOnlyStatus", "checkedAt"]) {
    assert.ok(key in status, `missing v0.12 field ${key}`);
  }
  assert.equal(status.version, "0.13.0-test");
  assert.equal(status.activeRuns, 3);
  assert.equal(status.awaitingApprovalRuns, 2);
  assert.equal(status.mockAvailable, true);
  assert.equal(status.codexReadOnlyStatus, "available");
});

test("cockpit also exposes the deprecated backward-compatible alias fields", () => {
  const status = projectCockpitStatus(baseContext);
  for (const key of ["routerVersion", "activeOrWaitingRuns", "updatedAt", "lastRunStatus"]) {
    assert.ok(key in status, `missing alias field ${key}`);
  }
});

test("activeOrWaitingRuns equals activeRuns + awaitingApprovalRuns", () => {
  assert.equal(projectCockpitStatus(baseContext).activeOrWaitingRuns, 5);
  assert.equal(projectCockpitStatus({ ...baseContext, activeRuns: 0, awaitingApprovalRuns: 0 }).activeOrWaitingRuns, 0);
  // Invalid counts fall back to 0 and stay consistent.
  assert.equal(projectCockpitStatus({ ...baseContext, activeRuns: -4, awaitingApprovalRuns: 1 }).activeOrWaitingRuns, 1);
});

test("routerVersion mirrors version and updatedAt mirrors checkedAt", () => {
  const status = projectCockpitStatus(baseContext);
  assert.equal(status.routerVersion, status.version);
  assert.equal(status.updatedAt, status.checkedAt);
});

test("lastRunStatus is a safe run-status enum value or null", () => {
  assert.equal(projectCockpitStatus(baseContext).lastRunStatus, "succeeded");
  assert.equal(projectCockpitStatus({ ...baseContext, lastRunStatus: "awaiting_approval" }).lastRunStatus, "awaiting_approval");
  assert.equal(projectCockpitStatus({ ...baseContext, lastRunStatus: "NOT_A_STATUS" }).lastRunStatus, null);
  assert.equal(projectCockpitStatus({ ...baseContext, lastRunStatus: undefined }).lastRunStatus, null);
  assert.equal(projectCockpitStatus({ ...baseContext, lastRunStatus: "<script>" }).lastRunStatus, null);
});

test("the compatibility aliases carry no tasks, prompts, results, logs, paths or controls", () => {
  const status = projectCockpitStatus({ ...baseContext, task: "PRIVATE TASK", runs: [{ prompt: "P" }], cancel: true, approval: { note: "x" }, resultSummary: "R", logPath: "C:\\secret\\log.jsonl" });
  const serialized = JSON.stringify(status);
  for (const marker of ["PRIVATE", "prompt", "runs", "cancel", "approval", "resultSummary", "C:\\", "secret", ".jsonl"]) {
    assert.equal(serialized.includes(marker), false, `leaked: ${marker}`);
  }
});

test("lastRunStatus reflects the most recently updated run from the live service snapshot", async () => {
  const gitState = { repository: "C:\\repo", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" };
  const service = new RunService({
    adapters: { mock: createMockAdapter({ stepDelayMs: 1 }) },
    git: { captureGitState: async () => ({ ...gitState }), compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {}, publish: async () => {}
  });
  assert.equal(projectCockpitStatus(service.cockpitContext()).lastRunStatus, null);
  const created = await service.create({ task: "Sortiere meine Einkaufsliste", adapter: "mock", simulationMode: "success" });
  const deadline = Date.now() + 4_000;
  while (service.get(created.runId).status !== "succeeded" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  const status = projectCockpitStatus(service.cockpitContext());
  assert.equal(status.lastRunStatus, "succeeded");
  assert.equal(status.reachable, true);
});
