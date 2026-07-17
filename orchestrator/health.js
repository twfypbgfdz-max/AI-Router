import { ROUTER_VERSION } from "./config.js";
import { SCHEMA_VERSION } from "./policy.js";
import { projectAdapterStatus } from "./adapter-status.js";

// Single, safe health projection. It deliberately excludes local paths,
// environment variables, task content, raw errors and stacktraces. Version is
// only the router's own semantic version string, no host/system details.
// Bounds the provider registry status to a small, safe operational shape — only
// counts, enums and a short provider status list. No models, paths or config.
function safeProviderLayer(providers = {}) {
  const statuses = Array.isArray(providers.providerStatuses) ? providers.providerStatuses.slice(0, 12).map((entry) => ({
    providerId: typeof entry.providerId === "string" ? entry.providerId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) : null,
    status: typeof entry.status === "string" ? entry.status.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) : "unknown",
    simulated: entry.simulated === true,
    executable: entry.executable === true,
    checkedAt: typeof entry.checkedAt === "string" ? entry.checkedAt : null
  })).filter((entry) => entry.providerId) : [];
  const num = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
  return {
    providerRegistryStatus: providers.registryStatus === "ok" || providers.registryStatus === "degraded" ? providers.registryStatus : "unknown",
    providerCount: num(providers.providerCount),
    enabledProviderCount: num(providers.enabledProviderCount),
    simulatedProviderCount: num(providers.simulatedProviderCount),
    executableProviderCount: num(providers.executableProviderCount),
    providerStatuses: statuses
  };
}

export function buildHealthStatus({ snapshot = {}, adapterStatus = {}, storage = {}, logging = {}, providers = {}, startedAt = Date.now(), now = () => Date.now() } = {}) {
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
    loggingStatus: typeof logging.status === "string" ? logging.status : "unknown",
    ...safeProviderLayer(providers)
  };
}
