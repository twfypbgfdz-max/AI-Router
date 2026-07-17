import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunStore } from "../orchestrator/run-store.js";
import { buildHealthStatus } from "../orchestrator/health.js";
import { buildDiagnostics } from "../orchestrator/diagnostics.js";

const adapterStatus = { mock: { state: "available" }, "codex-cli": { state: "unchecked" } };

test("storageHealth reports unavailable when the data directory cannot be created", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-store-bad-"));
  const blocker = path.join(dir, "blocker");
  await fs.writeFile(blocker, "x", "utf8");
  try {
    const store = createRunStore({
      runsDir: path.join(blocker, "runs"),
      latestRunFile: path.join(blocker, "latest.json"),
      historyIndexFile: path.join(blocker, "run-history.json"),
      dataDir: path.join(blocker, "data")
    });
    const health = await store.storageHealth();
    assert.equal(health.runStoreAvailable, false);
    assert.equal(health.status, "unavailable");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("listRuns and getRunSummary never throw on a corrupted store", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-store-corrupt-"));
  try {
    await fs.writeFile(path.join(dir, "run-history.json"), "<<<not json>>>", "utf8");
    const store = createRunStore({ runsDir: path.join(dir, "runs"), latestRunFile: path.join(dir, "latest.json"), historyIndexFile: path.join(dir, "run-history.json"), dataDir: dir });
    const page = await store.listRuns();
    assert.deepEqual(page.runs, []);
    assert.equal(page.storageDegraded, true);
    assert.equal(await store.getRunSummary("anything"), null);
    const snapshot = await store.historySnapshot();
    assert.deepEqual(snapshot.runs, []);
    assert.equal(snapshot.degraded, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a run persistence failure is reported without inventing data", async () => {
  // Simulate an unwritable data area: saveRun must reject, not silently succeed.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-store-ro-"));
  const blocker = path.join(dir, "blocker");
  await fs.writeFile(blocker, "x", "utf8");
  try {
    const store = createRunStore({ runsDir: path.join(blocker, "runs"), latestRunFile: path.join(blocker, "latest.json"), historyIndexFile: path.join(blocker, "history.json"), dataDir: path.join(blocker, "data") });
    await assert.rejects(store.saveRun({ runId: "r", status: "succeeded" }));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("health enters a safe restricted mode when storage is unavailable", () => {
  const snapshot = { serviceStatus: "ok", activeRuns: 0, queuedRuns: 0, awaitingApprovalRuns: 0, lastSuccessfulRunAt: null, lastFailedRunAt: null, lastSafeErrorCode: null };
  const health = buildHealthStatus({ snapshot, adapterStatus, storage: { runStoreAvailable: false, status: "unavailable" }, logging: { present: false, sizeClass: "none", status: "unavailable" }, startedAt: Date.now() });
  assert.equal(health.serviceStatus, "degraded");
  assert.equal(health.storageStatus, "unavailable");
  assert.equal(health.loggingStatus, "unavailable");
  // The router keeps answering with a valid, honest contract instead of crashing.
  assert.equal(health.version, "0.12.1-test");
});

test("diagnostics stays valid and empty when there is no history", () => {
  const diag = buildDiagnostics({ history: { total: 0, runs: [] }, adapterStatus, storage: { runStoreAvailable: true, status: "ok" }, logging: { present: false, sizeClass: "none", status: "ok" } });
  assert.equal(diag.totalRunsTracked, 0);
  assert.deepEqual(diag.runsByStatus, {});
  assert.equal(diag.averageDurationMs, null);
  assert.equal(diag.logFilePresent, false);
});
