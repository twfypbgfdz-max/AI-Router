import test from "node:test";
import assert from "node:assert/strict";
import { buildHealthStatus } from "../orchestrator/health.js";
import { buildDiagnostics } from "../orchestrator/diagnostics.js";

const adapterStatus = {
  mock: { state: "available", checkedAt: "2026-01-01T00:00:00.000Z", safeErrorCode: null },
  "codex-cli": { state: "unavailable", checkedAt: "2026-01-01T00:00:00.000Z", safeErrorCode: "CODEX_CLI_NOT_FOUND" }
};
const okStorage = { runStoreAvailable: true, status: "ok" };
const okLogging = { present: true, sizeClass: "small", status: "ok" };
const snapshot = { serviceStatus: "ok", activeRuns: 1, queuedRuns: 1, awaitingApprovalRuns: 0, lastSuccessfulRunAt: "2026-01-01T00:00:00.000Z", lastFailedRunAt: null, lastSafeErrorCode: null };

test("health exposes the full operational contract fields", () => {
  const health = buildHealthStatus({ snapshot, adapterStatus, storage: okStorage, logging: okLogging, startedAt: Date.now() - 5_000 });
  for (const key of ["serviceStatus", "version", "schemaVersion", "uptimeSeconds", "serverTime", "activeRuns", "awaitingApprovalRuns", "queuedRuns", "lastSuccessfulRunAt", "lastFailedRunAt", "lastSafeErrorCode", "adapterStatus", "storageStatus", "loggingStatus"]) {
    assert.ok(key in health, `missing ${key}`);
  }
  assert.equal(health.serviceStatus, "ok");
  assert.equal(health.version, "0.13.0-test");
  assert.ok(health.uptimeSeconds >= 4);
  assert.equal(health.adapterStatus["codex-cli"].state, "unavailable");
});

test("health degrades when storage or logging is not ok", () => {
  const degradedStorage = buildHealthStatus({ snapshot, adapterStatus, storage: { runStoreAvailable: false, status: "unavailable" }, logging: okLogging, startedAt: Date.now() });
  assert.equal(degradedStorage.serviceStatus, "degraded");
  const degradedLogging = buildHealthStatus({ snapshot, adapterStatus, storage: okStorage, logging: { present: false, sizeClass: "none", status: "unavailable" }, startedAt: Date.now() });
  assert.equal(degradedLogging.serviceStatus, "degraded");
});

test("health contains no local paths, env, task content or raw errors", () => {
  const serialized = JSON.stringify(buildHealthStatus({ snapshot, adapterStatus, storage: okStorage, logging: okLogging, startedAt: Date.now() }));
  for (const marker of ["C:\\", "/Users/", "process.env", "Error:", "at Object", ".exe"]) {
    assert.equal(serialized.includes(marker), false, `leaked: ${marker}`);
  }
});

test("diagnostics aggregates counts, durations, retries, timeouts and cancels", () => {
  const history = { total: 4, runs: [
    { runId: "a", status: "succeeded", durationMs: 100, retryCount: 0, safeErrorCode: null, finishedAt: "2026-01-01T00:00:04.000Z" },
    { runId: "b", status: "failed", durationMs: 200, retryCount: 1, safeErrorCode: "ADAPTER_FAILED", finishedAt: "2026-01-01T00:00:03.000Z" },
    { runId: "c", status: "timed_out", durationMs: 300, retryCount: 0, safeErrorCode: "STEP_TIMEOUT", finishedAt: "2026-01-01T00:00:02.000Z" },
    { runId: "d", status: "cancelled", durationMs: null, retryCount: 0, safeErrorCode: null, finishedAt: "2026-01-01T00:00:01.000Z" }
  ] };
  const diag = buildDiagnostics({ history, adapterStatus, storage: okStorage, logging: okLogging });
  assert.equal(diag.totalRunsTracked, 4);
  assert.equal(diag.runsByStatus.succeeded, 1);
  assert.equal(diag.timeoutCount, 1);
  assert.equal(diag.cancelledCount, 1);
  assert.equal(diag.failedCount, 1);
  assert.equal(diag.retryCount, 1);
  assert.equal(diag.averageDurationMs, 200);
  assert.deepEqual(diag.errorsBySafeCode, { ADAPTER_FAILED: 1, STEP_TIMEOUT: 1 });
  assert.equal(diag.logSizeClass, "small");
  assert.equal(diag.logFilePresent, true);
  assert.equal(diag.runStoreAvailable, true);
});

test("diagnostics returns no raw logs, no exact size and no file paths", () => {
  const serialized = JSON.stringify(buildDiagnostics({ history: { total: 0, runs: [] }, adapterStatus, storage: okStorage, logging: okLogging }));
  for (const marker of ["C:\\", "/Users/", ".jsonl", ".exe", "router-events"]) {
    assert.equal(serialized.includes(marker), false, `leaked: ${marker}`);
  }
  assert.equal(/"logSizeClass":"(none|small|medium|large|unknown)"/.test(serialized), true);
});
