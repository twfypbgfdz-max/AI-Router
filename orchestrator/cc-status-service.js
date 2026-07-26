import { ROUTER_VERSION } from "./config.js";
import { ROUTER_ACTIVE_MODES } from "./policy.js";
import { providerRegistry } from "./provider-registry.js";

// The only individual-provider status values the registry can ever produce.
// "degraded" is intentionally absent here — it exists only as an aggregate
// (registryStatus / routerStatus), never on a single provider.
const PROVIDER_STATUS_VALUES = new Set(["available", "unavailable", "unknown", "invalid"]);

function projectCcProvider(entry) {
  if (!entry || typeof entry !== "object") return null;
  const providerId = typeof entry.providerId === "string" ? entry.providerId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) : "";
  if (!providerId) return null;
  return Object.freeze({
    providerId,
    status: PROVIDER_STATUS_VALUES.has(entry.status) ? entry.status : "unknown",
    simulated: entry.simulated === true,
    executable: entry.executable === true,
    // No per-provider check is ever performed for this endpoint; checkedAt is
    // currently always null and carries no freshness/liveness guarantee.
    checkedAt: typeof entry.checkedAt === "string" ? entry.checkedAt : null
  });
}

// Pure, synchronous aggregation of already-existing router data. Never
// contacts a provider, never reads logs, never computes usage figures.
export function buildCcStatusData({ registry = providerRegistry } = {}) {
  const status = registry.status();
  const routerStatus = status.registryStatus === "ok" ? "ok" : "degraded";
  const providers = Array.isArray(status.providerStatuses)
    ? status.providerStatuses.map(projectCcProvider).filter(Boolean)
    : [];
  return Object.freeze({
    routerVersion: ROUTER_VERSION,
    routerStatus,
    activeModes: Object.freeze([...ROUTER_ACTIVE_MODES]),
    providers: Object.freeze(providers),
    usage: Object.freeze({
      available: false,
      source: "unavailable",
      requestsInWindow: null,
      requestLimit: null,
      remainingRequests: null,
      windowResetAt: null
    })
  });
}
