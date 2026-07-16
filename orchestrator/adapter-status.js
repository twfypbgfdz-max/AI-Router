import { ADAPTER_STATUS_CACHE_MS } from "./config.js";
import { resolveCodexExecutable } from "./codex-adapter.js";
import { isMockSimulationMode, runMock, runMockRole } from "./mock-adapter.js";

export const ADAPTER_STATES = Object.freeze(["unchecked", "checking", "available", "unavailable", "unsupported"]);

function nowIso(now) { return new Date(now()).toISOString(); }

function isoOrNull(value) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; }

// Safe projection: only the fixed state enum, a timestamp and a safe code.
// Never leaks executable paths, versions or environment details.
export function projectAdapterStatus(current = {}) {
  const one = (entry) => ({
    state: ADAPTER_STATES.includes(entry?.state) ? entry.state : "unchecked",
    checkedAt: isoOrNull(entry?.checkedAt),
    safeErrorCode: typeof entry?.safeErrorCode === "string" ? entry.safeErrorCode : null
  });
  return { mock: one(current.mock), "codex-cli": one(current["codex-cli"]) };
}

// The mock adapter counts as available only when its own configuration is
// structurally valid — not merely because the module loaded.
export function isMockAdapterValid() {
  return typeof runMock === "function" && typeof runMockRole === "function" && isMockSimulationMode("success") && !isMockSimulationMode("write");
}

// Maps the controlled resolve errors to a safe adapter state and code.
export async function defaultProbeCodex() {
  try {
    await resolveCodexExecutable();
    return { state: "available", safeErrorCode: null };
  } catch (error) {
    if (error?.code === "CODEX_CLI_UNSUPPORTED") return { state: "unsupported", safeErrorCode: "CODEX_CLI_UNSUPPORTED" };
    if (error?.code === "CODEX_CLI_NOT_FOUND") return { state: "unavailable", safeErrorCode: "CODEX_CLI_NOT_FOUND" };
    return { state: "unavailable", safeErrorCode: "CODEX_PROCESS_START_FAILED" };
  }
}

export function createAdapterStatusMonitor({
  probeCodex = defaultProbeCodex,
  mockValid = isMockAdapterValid,
  cacheMs = ADAPTER_STATUS_CACHE_MS,
  now = () => Date.now()
} = {}) {
  const state = {
    mock: { state: "unchecked", checkedAt: null, safeErrorCode: null },
    "codex-cli": { state: "unchecked", checkedAt: null, safeErrorCode: null }
  };
  let inFlight = null;

  const snapshot = () => ({ mock: { ...state.mock }, "codex-cli": { ...state["codex-cli"] } });

  function isFresh() {
    const checkedAt = state["codex-cli"].checkedAt;
    if (!checkedAt || state["codex-cli"].state === "unchecked") return false;
    return now() - Date.parse(checkedAt) < cacheMs;
  }

  async function runRefresh() {
    const mockOk = mockValid();
    state.mock = { state: mockOk ? "available" : "unavailable", checkedAt: nowIso(now), safeErrorCode: mockOk ? null : null };
    state["codex-cli"] = { ...state["codex-cli"], state: "checking" };
    try {
      const probe = await probeCodex();
      const resolved = ADAPTER_STATES.includes(probe?.state) ? probe.state : "unavailable";
      state["codex-cli"] = { state: resolved, checkedAt: nowIso(now), safeErrorCode: probe?.safeErrorCode || null };
    } catch {
      state["codex-cli"] = { state: "unavailable", checkedAt: nowIso(now), safeErrorCode: "CODEX_PROCESS_START_FAILED" };
    }
    return snapshot();
  }

  return {
    // Cheap, synchronous read of the cached state — safe for every page load.
    current() { return snapshot(); },
    // Refreshes at most once per cache window unless forced (manual re-check).
    // Concurrent callers share a single in-flight check.
    async refresh({ force = false } = {}) {
      if (!force && isFresh()) return snapshot();
      if (inFlight) return inFlight;
      inFlight = runRefresh().finally(() => { inFlight = null; });
      return inFlight;
    }
  };
}
