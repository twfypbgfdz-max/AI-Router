// Read-only client for Felix Command Center's GET /api/companion/status -
// DEC-010 Phase 4B. Everything this module is allowed to do: build one GET
// request from server-only configuration, verify transport shape (content
// type, size, JSON), and hand back exactly the seven fields of the
// Status-Companion-Datenvertrag v1
// (felix-command-center/docs/specs/Status-Companion-Datenvertrag-v1.md),
// re-validated defensively against this module's own copy of the allowed
// fields/enums - it never trusts the network boundary just because Command
// Center already validates on its side (server/status/companion-contract.js).
//
// No interpretation happens here, by design (DEC-005 Abschnitt 5, DEC-010
// Abschnitt 7): no combining fields, no deriving a status from other
// fields, and specifically no client-side freshness calculation - the
// seven values are passed through exactly as received, or not at all. The
// base URL comes exclusively from the server's own environment
// (AI_ROUTER_COMMAND_CENTER_BASE_URL) - unset means "unconfigured", no
// unsolicited request to Command Center's port. No token: the companion
// endpoint requires none (127.0.0.1-only trust, same as every other local
// read in Felix Core), mirroring cockpit-client.js in every other respect.
//
// Fail-closed by construction: any missing config, network error, timeout,
// wrong content type, oversized body, invalid JSON, wrong schemaVersion,
// missing field or unexpected extra field collapses to state "unavailable"
// (or "unconfigured" when nothing was even attempted) - never a thrown
// error, never a partial guess.

export const COMMAND_CENTER_BASE_URL_ENV_VAR = "AI_ROUTER_COMMAND_CENTER_BASE_URL";
export const COMPANION_STATUS_PATH = "/api/companion/status";
export const COMPANION_STATUS_TIMEOUT_MS = 2_500;
export const COMPANION_STATUS_MAX_BODY_BYTES = 4_096; // seven small fields - generous, still a hard cap.

const CONTRACT_SCHEMA_VERSION = "1.0";
const LEVEL_VALUES = new Set(["ok", "warning", "error"]);
const FRESHNESS_VALUES = new Set(["fresh", "stale", "unknown"]);
// Exact, closed field list per the contract's own "Fehlerverhalten"
// section: missing OR unexpected fields both invalidate the whole payload,
// no partial rendering.
const ALLOWED_FIELDS = Object.freeze([
  "schemaVersion",
  "generatedAt",
  "overallStatus",
  "aiRouterOverallStatus",
  "activeWarningCount",
  "lastSuccessfulUpdate",
  "statusFreshness"
]);

function trimmedEnvString(env, key) {
  const raw = env?.[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

// Re-validates the full contract shape from scratch. Returns the seven
// fields unchanged (never re-derives, never combines) or null when the
// payload does not exactly match the contract - the same "invalid means
// invalid, not degraded" rule the contract's own server-side validator
// applies.
function normalizeCompanionStatus(payload) {
  if (!isPlainObject(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.length !== ALLOWED_FIELDS.length || !ALLOWED_FIELDS.every((field) => keys.includes(field))) return null;
  if (payload.schemaVersion !== CONTRACT_SCHEMA_VERSION) return null;
  if (!isIsoTimestamp(payload.generatedAt)) return null;
  if (!LEVEL_VALUES.has(payload.overallStatus)) return null;
  if (!LEVEL_VALUES.has(payload.aiRouterOverallStatus)) return null;
  if (!Number.isInteger(payload.activeWarningCount) || payload.activeWarningCount < 0) return null;
  if (!isIsoTimestamp(payload.lastSuccessfulUpdate)) return null;
  if (!FRESHNESS_VALUES.has(payload.statusFreshness)) return null;

  return Object.freeze({
    schemaVersion: payload.schemaVersion,
    generatedAt: payload.generatedAt,
    overallStatus: payload.overallStatus,
    aiRouterOverallStatus: payload.aiRouterOverallStatus,
    activeWarningCount: payload.activeWarningCount,
    lastSuccessfulUpdate: payload.lastSuccessfulUpdate,
    statusFreshness: payload.statusFreshness
  });
}

async function readBoundedJson(response, maxBodyBytes) {
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) return null;
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    response.body?.cancel?.().catch?.(() => {});
    return null;
  }
  let raw;
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  if (Buffer.byteLength(raw, "utf8") > maxBodyBytes) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const UNAVAILABLE_RESULT = Object.freeze({ state: "unavailable", status: null });
const UNCONFIGURED_RESULT = Object.freeze({ state: "unconfigured", status: null });

// Never throws. `state` tells the caller whether anything usable came
// back; `status` is the closed seven-field object (or null) - identical in
// shape to the felix-command-center contract, nothing added, nothing
// derived.
export async function fetchCommandCenterStatus({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = COMPANION_STATUS_TIMEOUT_MS,
  maxBodyBytes = COMPANION_STATUS_MAX_BODY_BYTES
} = {}) {
  const baseUrl = trimmedEnvString(env, COMMAND_CENTER_BASE_URL_ENV_VAR);
  if (!baseUrl) return UNCONFIGURED_RESULT;

  let url;
  try {
    url = new URL(COMPANION_STATUS_PATH, baseUrl).toString();
  } catch {
    return UNCONFIGURED_RESULT;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json" }
      });
    } catch {
      return UNAVAILABLE_RESULT;
    }
    if (!response?.ok) {
      response?.body?.cancel?.().catch?.(() => {});
      return UNAVAILABLE_RESULT;
    }
    const payload = await readBoundedJson(response, maxBodyBytes);
    const status = normalizeCompanionStatus(payload);
    if (!status) return UNAVAILABLE_RESULT;

    return Object.freeze({ state: "ok", status });
  } finally {
    clearTimeout(timer);
  }
}

export const commandCenterClientInternals = Object.freeze({ normalizeCompanionStatus });
