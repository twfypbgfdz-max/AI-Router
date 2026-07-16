import test from "node:test";
import assert from "node:assert/strict";
import { projectCockpitStatus } from "../orchestrator/cockpit-status.js";

const context = {
  serviceStatus: "ok", activeRuns: 2, awaitingApprovalRuns: 1,
  lastSuccessfulRunAt: "2026-01-01T00:00:00.000Z", lastSafeErrorCode: "ADAPTER_FAILED",
  adapterStatus: { mock: { state: "available" }, "codex-cli": { state: "unsupported" } },
  checkedAt: "2026-01-01T00:00:05.000Z"
};

test("cockpit contract exposes exactly the allowed read-only fields", () => {
  const status = projectCockpitStatus(context);
  assert.deepEqual(Object.keys(status).sort(), [
    "activeRuns", "awaitingApprovalRuns", "checkedAt", "codexReadOnlyStatus",
    "lastSafeErrorCode", "lastSuccessfulRunAt", "mockAvailable", "reachable", "serviceStatus", "version"
  ].sort());
});

test("cockpit maps adapter availability into its stable booleans and enums", () => {
  const status = projectCockpitStatus(context);
  assert.equal(status.reachable, true);
  assert.equal(status.mockAvailable, true);
  assert.equal(status.codexReadOnlyStatus, "unsupported");
  assert.equal(status.version, "0.12.0-test");
  assert.equal(status.activeRuns, 2);
  assert.equal(status.awaitingApprovalRuns, 1);
  assert.equal(status.lastSafeErrorCode, "ADAPTER_FAILED");
});

test("cockpit never exposes run lists, tasks, prompts, results, logs or controls", () => {
  const status = projectCockpitStatus({ ...context, runs: [{ task: "PRIVATE" }], task: "PRIVATE TASK", cancel: true, approval: { note: "x" } });
  const serialized = JSON.stringify(status);
  for (const marker of ["PRIVATE", "runs", "cancel", "approval", "task", "prompt", "result", "log"]) {
    assert.equal(serialized.includes(marker), false, `leaked: ${marker}`);
  }
});

test("cockpit falls back to safe defaults for unknown or invalid input", () => {
  const status = projectCockpitStatus({ serviceStatus: "explode", lastSafeErrorCode: "NOT_A_CODE", activeRuns: -5 });
  assert.equal(status.serviceStatus, "ok");
  assert.equal(status.lastSafeErrorCode, null);
  assert.equal(status.activeRuns, 0);
  assert.equal(status.codexReadOnlyStatus, "unchecked");
  assert.equal(status.mockAvailable, false);
});
