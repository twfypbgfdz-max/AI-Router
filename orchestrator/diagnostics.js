import { ROUTER_VERSION } from "./config.js";
import { ERROR_CODES, SCHEMA_VERSION } from "./policy.js";
import { projectAdapterStatus } from "./adapter-status.js";
import { compareRunSummaryNewestFirst } from "./run-summary.js";

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    if (key === null || key === undefined) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function firstFinishedAt(runs, predicate) {
  const match = runs.filter(predicate).sort(compareRunSummaryNewestFirst)[0];
  return match?.finishedAt || null;
}

// Safe, summarized operational diagnostics. Returns ONLY aggregated counters,
// coarse log-size classes and safe status enums — no raw logs, no download,
// no file paths, no write surface.
export function buildDiagnostics({ history = { runs: [], total: 0 }, adapterStatus = {}, storage = {}, logging = {}, now = () => Date.now() } = {}) {
  const runs = Array.isArray(history.runs) ? history.runs : [];
  const durations = runs.map((run) => run.durationMs).filter((value) => Number.isFinite(value) && value >= 0);
  const averageDurationMs = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null;
  const errorsBySafeCode = countBy(runs.filter((run) => ERROR_CODES.includes(run.safeErrorCode)), (run) => run.safeErrorCode);
  const runsByStatus = countBy(runs, (run) => run.status);
  return {
    version: ROUTER_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(now()).toISOString(),
    totalRunsTracked: Number.isFinite(history.total) ? history.total : runs.length,
    runsByStatus,
    errorsBySafeCode,
    averageDurationMs,
    retryCount: runs.reduce((sum, run) => sum + (Number.isFinite(run.retryCount) ? run.retryCount : 0), 0),
    timeoutCount: runsByStatus.timed_out || 0,
    cancelledCount: runsByStatus.cancelled || 0,
    failedCount: runsByStatus.failed || 0,
    succeededCount: runsByStatus.succeeded || 0,
    lastSuccessfulRunAt: firstFinishedAt(runs, (run) => run.status === "succeeded"),
    lastFailedRunAt: firstFinishedAt(runs, (run) => run.status === "failed" || run.status === "timed_out"),
    logFilePresent: logging.present === true,
    logSizeClass: typeof logging.sizeClass === "string" ? logging.sizeClass : "unknown",
    loggingStatus: typeof logging.status === "string" ? logging.status : "unknown",
    runStoreAvailable: storage.runStoreAvailable === true,
    storageStatus: typeof storage.status === "string" ? storage.status : "unknown",
    adapterStatus: projectAdapterStatus(adapterStatus)
  };
}
