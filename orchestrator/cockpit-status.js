import fs from "node:fs/promises";
import path from "node:path";
import { COCKPIT_STATUS_FILE, ROUTER_VERSION } from "./config.js";
import { ERROR_CODES } from "./policy.js";
import { ADAPTER_STATES } from "./adapter-status.js";

const SERVICE_STATUSES = new Set(["ok", "degraded"]);

function count(value) { return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0; }
function iso(value) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; }

// Stable, read-only cockpit contract. It exposes ONLY liveness and safe
// operational counters — never run lists, task content, prompts, results,
// logs, approval controls, cancel controls or any write surface.
export function projectCockpitStatus(context = {}) {
  const adapters = context.adapterStatus && typeof context.adapterStatus === "object" ? context.adapterStatus : {};
  const codexState = adapters["codex-cli"]?.state;
  return {
    reachable: true,
    serviceStatus: SERVICE_STATUSES.has(context.serviceStatus) ? context.serviceStatus : "ok",
    version: ROUTER_VERSION,
    activeRuns: count(context.activeRuns),
    awaitingApprovalRuns: count(context.awaitingApprovalRuns),
    lastSuccessfulRunAt: iso(context.lastSuccessfulRunAt),
    lastSafeErrorCode: ERROR_CODES.includes(context.lastSafeErrorCode) ? context.lastSafeErrorCode : null,
    mockAvailable: adapters.mock?.state === "available",
    codexReadOnlyStatus: ADAPTER_STATES.includes(codexState) ? codexState : "unchecked",
    checkedAt: iso(context.checkedAt) || new Date().toISOString()
  };
}

export function createCockpitStatusStore({ file }) {
  return {
    async saveCockpitStatus(context) {
      const value = projectCockpitStatus(context);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await fs.rename(temporary, file);
      return value;
    },
    async loadCockpitStatus() {
      try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
    }
  };
}

const productionCockpitStatusStore = createCockpitStatusStore({ file: COCKPIT_STATUS_FILE });
export const saveCockpitStatus = productionCockpitStatusStore.saveCockpitStatus;
export const loadCockpitStatus = productionCockpitStatusStore.loadCockpitStatus;
