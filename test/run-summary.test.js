import test from "node:test";
import assert from "node:assert/strict";
import { compareRunSummaryNewestFirst, projectRunSummary } from "../orchestrator/run-summary.js";

const richRun = {
  runId: "run_1", requestId: "req_1", schemaVersion: 1,
  task: "PRIVATE TASK TEXT lösche alle Dateien", context: "PRIVATE CONTEXT", repository: "C:\\Users\\felil\\private\\repo",
  executable: "C:\\Users\\felil\\AppData\\codex.exe", adapter: "codex-cli", status: "succeeded", success: true,
  routePlan: { recommendedRoute: "codex-cli", risk: "R2" }, workflow: { type: "plan_execute_review" },
  approval: { status: "approved" }, retry: { count: 1 }, durationMs: 1234,
  startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.234Z",
  errorCode: "ADAPTER_FAILED", warnings: ["w1", "w2"], resultSummary: "some safe summary",
  events: [{ text: "PRIVATE EVENT TEXT" }], stderr: "PRIVATE STDERR"
};

test("projectRunSummary exposes only the allowlisted safe metadata fields", () => {
  const summary = projectRunSummary(richRun);
  assert.deepEqual(Object.keys(summary).sort(), [
    "adapter", "approvalState", "durationMs", "finishedAt", "requestId", "resultAvailable",
    "retryCount", "riskLevel", "route", "runId", "safeErrorCode", "schemaVersion", "sessionId", "startedAt",
    "status", "success", "warningsCount", "workflowType",
    "selectedProviderId", "selectedModelId", "providerWorkflowProfile", "providersUsed", "providerCount",
    "simulatedProviderCount", "realLocalAdapterUsed", "providerSelectionMode", "providerFallbackUsed", "providerWarningsCount"
  ].sort());
  assert.equal(summary.adapter, "codex-cli");
  assert.equal(summary.riskLevel, "R2");
  assert.equal(summary.approvalState, "approved");
  assert.equal(summary.retryCount, 1);
  assert.equal(summary.durationMs, 1234);
  assert.equal(summary.warningsCount, 2);
  assert.equal(summary.resultAvailable, true);
  assert.equal(summary.workflowType, "plan_execute_review");
});

test("projectRunSummary never leaks task, context, paths, stdout/stderr or event text", () => {
  const serialized = JSON.stringify(projectRunSummary(richRun));
  for (const secret of ["PRIVATE TASK", "PRIVATE CONTEXT", "private\\repo", "codex.exe", "PRIVATE EVENT", "PRIVATE STDERR", "some safe summary"]) {
    assert.equal(serialized.includes(secret), false, `leaked: ${secret}`);
  }
});

test("projectRunSummary defaults approvalState and errorCode safely", () => {
  const summary = projectRunSummary({ runId: "run_2", status: "failed", adapter: "mock", errorCode: "NOT_A_REAL_CODE" });
  assert.equal(summary.approvalState, "not_required");
  assert.equal(summary.safeErrorCode, null);
  assert.equal(summary.success, false);
  assert.equal(summary.resultAvailable, false);
});

test("projectRunSummary rejects non-objects", () => {
  assert.equal(projectRunSummary(null), null);
  assert.equal(projectRunSummary("x"), null);
  assert.equal(projectRunSummary([]), null);
});

test("compareRunSummaryNewestFirst orders by finishedAt then startedAt descending", () => {
  const a = { finishedAt: "2026-01-01T00:00:03.000Z" };
  const b = { finishedAt: "2026-01-01T00:00:01.000Z" };
  const c = { startedAt: "2026-01-01T00:00:02.000Z" };
  const sorted = [b, c, a].sort(compareRunSummaryNewestFirst);
  assert.deepEqual(sorted, [a, c, b]);
});
