import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, DEFAULT_HISTORY_LIMIT, HISTORY_INDEX_FILE, LATEST_RUN_FILE, MAX_HISTORY_LIMIT, MAX_HISTORY_RUNS, RUNS_DIR } from "./config.js";
import { compareRunSummaryNewestFirst, projectRunSummary, sanitizeStoredSummary } from "./run-summary.js";

const HISTORY_SCHEMA_VERSION = 1;

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

function persistentRun(run) {
  const { task, context, repository, executable, gitBefore, approvalContext, ...safe } = run;
  return safe;
}

// Tolerant read of the bounded history index. A missing file is normal (no runs
// yet); an unreadable/corrupt file is reported as degraded without throwing so
// the operator still sees a safe, honest state instead of a crash.
async function readHistory(historyIndexFile) {
  if (!historyIndexFile) return { runs: [], degraded: false, present: false };
  let raw;
  try { raw = await fs.readFile(historyIndexFile, "utf8"); }
  catch { return { runs: [], degraded: false, present: false }; }
  try {
    const parsed = JSON.parse(raw);
    const runs = Array.isArray(parsed?.runs) ? parsed.runs.filter((item) => item && typeof item === "object") : [];
    return { runs, degraded: false, present: true };
  } catch {
    return { runs: [], degraded: true, present: true };
  }
}

// Bounds the history index to MAX_HISTORY_RUNS by dropping the oldest entries
// FROM THE INDEX only. Individual run files are never deleted here.
async function updateHistory(historyIndexFile, run) {
  if (!historyIndexFile) return;
  const summary = projectRunSummary(run);
  if (!summary?.runId) return;
  const { runs } = await readHistory(historyIndexFile);
  const withoutCurrent = runs.filter((item) => item.runId !== summary.runId);
  withoutCurrent.unshift(summary);
  withoutCurrent.sort(compareRunSummaryNewestFirst);
  const trimmed = withoutCurrent.slice(0, MAX_HISTORY_RUNS);
  await atomicWrite(historyIndexFile, { schemaVersion: HISTORY_SCHEMA_VERSION, updatedAt: new Date().toISOString(), runs: trimmed });
}

function clampLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_HISTORY_LIMIT;
  return Math.min(Math.floor(number), MAX_HISTORY_LIMIT);
}

function clampOffset(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function withinRange(summary, since, until) {
  const stamp = Date.parse(summary.finishedAt || summary.startedAt || "");
  if (since) { const from = Date.parse(since); if (Number.isFinite(from) && (!Number.isFinite(stamp) || stamp < from)) return false; }
  if (until) { const to = Date.parse(until); if (Number.isFinite(to) && (!Number.isFinite(stamp) || stamp > to)) return false; }
  return true;
}

export function createRunStore({ runsDir, latestRunFile, historyIndexFile = null, dataDir = null } = {}) {
  const baseDir = dataDir || (historyIndexFile ? path.dirname(historyIndexFile) : (runsDir ? path.dirname(runsDir) : null));
  return {
    async saveRun(run) {
      const safe = persistentRun(run);
      await atomicWrite(path.join(runsDir, `${run.runId}.json`), safe);
      await atomicWrite(latestRunFile, safe);
      // History indexing must never break the primary run persistence.
      try { await updateHistory(historyIndexFile, run); } catch { /* history stays best-effort */ }
    },
    async loadRun(runId) {
      return JSON.parse(await fs.readFile(path.join(runsDir, `${runId}.json`), "utf8"));
    },
    async loadLatestRun() {
      try { return JSON.parse(await fs.readFile(latestRunFile, "utf8")); } catch { return null; }
    },
    // Safe, paginated, filterable history built only from projected summaries.
    async listRuns({ limit, offset, status, adapter, since, until } = {}) {
      const history = await readHistory(historyIndexFile);
      let runs = history.runs.map(sanitizeStoredSummary).filter(Boolean);
      if (status) runs = runs.filter((item) => item.status === status);
      if (adapter) runs = runs.filter((item) => item.adapter === adapter);
      if (since || until) runs = runs.filter((item) => withinRange(item, since, until));
      runs.sort(compareRunSummaryNewestFirst);
      const total = runs.length;
      const safeLimit = clampLimit(limit);
      const safeOffset = clampOffset(offset);
      return { runs: runs.slice(safeOffset, safeOffset + safeLimit), total, limit: safeLimit, offset: safeOffset, storageDegraded: history.degraded };
    },
    // Full (bounded) projected history for diagnostics aggregation.
    async historySnapshot() {
      const history = await readHistory(historyIndexFile);
      const runs = history.runs.map(sanitizeStoredSummary).filter(Boolean).sort(compareRunSummaryNewestFirst);
      return { runs, total: runs.length, degraded: history.degraded };
    },
    // Safe single-run detail: never returns raw run content, only the projection.
    async getRunSummary(runId) {
      if (typeof runId !== "string" || !runId) return null;
      try {
        const run = JSON.parse(await fs.readFile(path.join(runsDir, `${path.basename(runId)}.json`), "utf8"));
        return projectRunSummary(run);
      } catch {
        const history = await readHistory(historyIndexFile);
        const found = history.runs.find((item) => item.runId === runId);
        return found ? sanitizeStoredSummary(found) : null;
      }
    },
    async storageHealth() {
      const result = { runStoreAvailable: false, status: "unavailable", historyDegraded: false };
      try {
        if (baseDir) { await fs.mkdir(baseDir, { recursive: true }); await fs.access(baseDir, fs.constants.W_OK); }
        const history = await readHistory(historyIndexFile);
        result.runStoreAvailable = true;
        result.historyDegraded = history.degraded;
        result.status = history.degraded ? "degraded" : "ok";
      } catch {
        result.runStoreAvailable = false;
        result.status = "unavailable";
      }
      return result;
    }
  };
}

const productionRunStore = createRunStore({ runsDir: RUNS_DIR, latestRunFile: LATEST_RUN_FILE, historyIndexFile: HISTORY_INDEX_FILE, dataDir: DATA_DIR });
export const saveRun = productionRunStore.saveRun;
export const loadRun = productionRunStore.loadRun;
export const loadLatestRun = productionRunStore.loadLatestRun;
export const listRuns = productionRunStore.listRuns;
export const getRunSummary = productionRunStore.getRunSummary;
export const historySnapshot = productionRunStore.historySnapshot;
export const storageHealth = productionRunStore.storageHealth;

export { DATA_DIR };
