import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunStore } from "../orchestrator/run-store.js";

async function tempStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-history-"));
  const store = createRunStore({
    runsDir: path.join(dataDir, "runs"),
    latestRunFile: path.join(dataDir, "latest-run.json"),
    historyIndexFile: path.join(dataDir, "run-history.json"),
    dataDir
  });
  return { store, dataDir, cleanup: () => fs.rm(dataDir, { recursive: true, force: true }) };
}

function run(id, overrides = {}) {
  return {
    runId: id, requestId: `req_${id}`, schemaVersion: 1, adapter: "mock", status: "succeeded",
    routePlan: { recommendedRoute: "mock", risk: "R0" }, workflow: { type: "direct" },
    retry: { count: 0 }, warnings: [], durationMs: 100,
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.100Z",
    task: "PRIVATE TASK", repository: "C:\\private", resultSummary: "safe", ...overrides
  };
}

test("history lists runs newest first", async () => {
  const { store, cleanup } = await tempStore();
  try {
    await store.saveRun(run("a", { finishedAt: "2026-01-01T00:00:01.000Z" }));
    await store.saveRun(run("b", { finishedAt: "2026-01-01T00:00:03.000Z" }));
    await store.saveRun(run("c", { finishedAt: "2026-01-01T00:00:02.000Z" }));
    const page = await store.listRuns();
    assert.deepEqual(page.runs.map((r) => r.runId), ["b", "c", "a"]);
    assert.equal(page.total, 3);
  } finally { await cleanup(); }
});

test("history preserves the projected safe fields through the index round-trip", async () => {
  const { store, cleanup } = await tempStore();
  try {
    await store.saveRun(run("a", { adapter: "codex-cli", routePlan: { recommendedRoute: "codex-cli", risk: "R2" }, workflow: { type: "plan_execute_review" }, retry: { count: 1 } }));
    const [summary] = (await store.listRuns()).runs;
    assert.equal(summary.route, "codex-cli");
    assert.equal(summary.workflowType, "plan_execute_review");
    assert.equal(summary.riskLevel, "R2");
    assert.equal(summary.retryCount, 1);
    assert.equal(summary.adapter, "codex-cli");
  } finally { await cleanup(); }
});

test("history respects a limit and reports the true total", async () => {
  const { store, cleanup } = await tempStore();
  try {
    for (let index = 0; index < 5; index += 1) {
      await store.saveRun(run(`r${index}`, { finishedAt: `2026-01-01T00:00:0${index}.000Z` }));
    }
    const page = await store.listRuns({ limit: 2 });
    assert.equal(page.runs.length, 2);
    assert.equal(page.total, 5);
    assert.equal(page.limit, 2);
  } finally { await cleanup(); }
});

test("history filters by status and adapter", async () => {
  const { store, cleanup } = await tempStore();
  try {
    await store.saveRun(run("ok", { status: "succeeded", adapter: "mock" }));
    await store.saveRun(run("bad", { status: "failed", adapter: "codex-cli", errorCode: "ADAPTER_FAILED" }));
    const failed = await store.listRuns({ status: "failed" });
    assert.deepEqual(failed.runs.map((r) => r.runId), ["bad"]);
    const codex = await store.listRuns({ adapter: "codex-cli" });
    assert.deepEqual(codex.runs.map((r) => r.runId), ["bad"]);
  } finally { await cleanup(); }
});

test("history detail returns a safe projection and unknown ids resolve to null", async () => {
  const { store, cleanup } = await tempStore();
  try {
    await store.saveRun(run("a"));
    const detail = await store.getRunSummary("a");
    assert.equal(detail.runId, "a");
    assert.equal(JSON.stringify(detail).includes("PRIVATE TASK"), false);
    assert.equal(JSON.stringify(detail).includes("private"), false);
    assert.equal(await store.getRunSummary("does-not-exist"), null);
    assert.equal(await store.getRunSummary("../../escape"), null);
  } finally { await cleanup(); }
});

test("the history index file itself contains no task text or local paths", async () => {
  const { store, dataDir, cleanup } = await tempStore();
  try {
    await store.saveRun(run("a"));
    const raw = await fs.readFile(path.join(dataDir, "run-history.json"), "utf8");
    assert.equal(raw.includes("PRIVATE TASK"), false);
    assert.equal(raw.includes("C:\\private"), false);
    assert.equal(raw.includes("resultSummary"), false);
    assert.equal(raw.includes("resultAvailable"), true);
  } finally { await cleanup(); }
});

test("saving the same run id updates its entry instead of duplicating it", async () => {
  const { store, cleanup } = await tempStore();
  try {
    await store.saveRun(run("a", { status: "running", finishedAt: null }));
    await store.saveRun(run("a", { status: "succeeded" }));
    const page = await store.listRuns();
    assert.equal(page.total, 1);
    assert.equal(page.runs[0].status, "succeeded");
  } finally { await cleanup(); }
});

test("a corrupted history index degrades safely without throwing", async () => {
  const { store, dataDir, cleanup } = await tempStore();
  try {
    await fs.writeFile(path.join(dataDir, "run-history.json"), "{ this is not valid json", "utf8");
    const page = await store.listRuns();
    assert.deepEqual(page.runs, []);
    assert.equal(page.storageDegraded, true);
    const health = await store.storageHealth();
    assert.equal(health.runStoreAvailable, true);
    assert.equal(health.status, "degraded");
  } finally { await cleanup(); }
});

test("historySnapshot aggregates the full bounded index", async () => {
  const { store, cleanup } = await tempStore();
  try {
    await store.saveRun(run("a", { status: "succeeded" }));
    await store.saveRun(run("b", { status: "failed", errorCode: "ADAPTER_FAILED" }));
    const snapshot = await store.historySnapshot();
    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.degraded, false);
  } finally { await cleanup(); }
});
