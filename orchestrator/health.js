import { ROUTER_VERSION } from "./config.js";
import { SCHEMA_VERSION } from "./policy.js";
import { projectAdapterStatus } from "./adapter-status.js";

// Single, safe health projection. It deliberately excludes local paths,
// environment variables, task content, raw errors and stacktraces. Version is
// only the router's own semantic version string, no host/system details.
export function buildHealthStatus({ snapshot = {}, adapterStatus = {}, storage = {}, logging = {}, startedAt = Date.now(), now = () => Date.now() } = {}) {
  const storageOk = storage.status === "ok";
  const loggingOk = logging.status === "ok";
  const serviceStatus = storageOk && loggingOk && snapshot.serviceStatus !== "degraded" ? "ok" : "degraded";
  return {
    serviceStatus,
    version: ROUTER_VERSION,
    schemaVersion: SCHEMA_VERSION,
    uptimeSeconds: Math.max(0, Math.round((now() - startedAt) / 1000)),
    serverTime: new Date(now()).toISOString(),
    activeRuns: Number.isFinite(snapshot.activeRuns) ? snapshot.activeRuns : 0,
    awaitingApprovalRuns: Number.isFinite(snapshot.awaitingApprovalRuns) ? snapshot.awaitingApprovalRuns : 0,
    queuedRuns: Number.isFinite(snapshot.queuedRuns) ? snapshot.queuedRuns : 0,
    lastSuccessfulRunAt: snapshot.lastSuccessfulRunAt || null,
    lastFailedRunAt: snapshot.lastFailedRunAt || null,
    lastSafeErrorCode: snapshot.lastSafeErrorCode || null,
    adapterStatus: projectAdapterStatus(adapterStatus),
    storageStatus: typeof storage.status === "string" ? storage.status : "unknown",
    loggingStatus: typeof logging.status === "string" ? logging.status : "unknown"
  };
}
