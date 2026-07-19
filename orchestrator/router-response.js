import { ROUTER_API_DEFAULT_MODE, ROUTER_API_SCHEMA_VERSION } from "./config.js";
import { ERROR_CODES } from "./policy.js";
import { sanitizeText } from "./jsonl.js";

const HTTP_STATUS_BY_ERROR = Object.freeze({
  INVALID_REQUEST: 400,
  UNSUPPORTED_SCHEMA_VERSION: 400,
  VALIDATION_FAILED: 422,
  ROUTE_NOT_FOUND: 422,
  ACTION_NOT_ALLOWLISTED: 403,
  EXECUTION_DISABLED: 403,
  ORIGIN_NOT_ALLOWED: 403,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_ERROR: 500,
  UNAVAILABLE: 503,
  TIMEOUT: 504
});
const SAFE_DETAIL_KEYS = new Set(["field", "reason", "expected", "limit", "supportedVersions", "validation", "issues"]);

function safePublicText(value, maximum = 300) {
  const sanitized = sanitizeText(value, maximum);
  if (!sanitized) return null;
  return sanitized
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\s]*/g, "[REDACTED_PATH]")
    .replace(/file:\/\/\/[^\s]+/gi, "[REDACTED_PATH]");
}

function projectSafeDetails(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return null;
  const projected = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue;
    if (typeof item === "string") {
      const text = safePublicText(item, 160);
      if (text) projected[key] = text;
    } else if (typeof item === "number" && Number.isFinite(item)) projected[key] = item;
    else if (Array.isArray(item)) projected[key] = item.filter((entry) => typeof entry === "string").map((entry) => safePublicText(entry, 120)).filter(Boolean).slice(0, 8);
    else {
      const nested = projectSafeDetails(item, depth + 1);
      if (nested) projected[key] = nested;
    }
  }
  return Object.keys(projected).length ? projected : null;
}

export function routerHttpStatus(errorCode) {
  return HTTP_STATUS_BY_ERROR[errorCode] || 500;
}

function routeView(decision) {
  return decision ? { name: decision.route, confidence: decision.confidence, reason: decision.reason, requiredCapabilities: [...decision.requiredCapabilities] } : null;
}

export function buildRouterSuccess({ request, decision, policy, durationMs, timestamp = new Date().toISOString() }) {
  return {
    schemaVersion: ROUTER_API_SCHEMA_VERSION,
    requestId: request.requestId,
    status: "success",
    mode: request.mode,
    route: routeView(decision),
    decision: { allowed: policy.allowed, action: policy.action, riskLevel: decision.riskLevel, requiresConfirmation: policy.requiresConfirmation === true },
    result: { executed: false, summary: `Die Anfrage wuerde an ${decision.route} weitergeleitet; es wurde nichts ausgefuehrt.`, data: null },
    error: null,
    meta: { durationMs, timestamp }
  };
}

export function buildRouterBlocked({ request, decision, durationMs, timestamp = new Date().toISOString() }) {
  return {
    schemaVersion: ROUTER_API_SCHEMA_VERSION,
    requestId: request.requestId,
    status: "success",
    mode: request.mode,
    route: routeView(decision),
    decision: { allowed: false, action: null, riskLevel: decision.riskLevel, requiresConfirmation: false },
    result: { executed: false, summary: "Die Anfrage wurde sicher erkannt und blockiert; es wurde nichts ausgefuehrt.", data: null },
    error: null,
    meta: { durationMs, timestamp }
  };
}

export function buildRouterFailure(error, { requestId = null, mode = ROUTER_API_DEFAULT_MODE, decision = null, durationMs = 0, timestamp = new Date().toISOString() } = {}) {
  const code = ERROR_CODES.includes(error?.code) ? error.code : "INTERNAL_ERROR";
  const internal = code === "INTERNAL_ERROR";
  return {
    schemaVersion: ROUTER_API_SCHEMA_VERSION,
    requestId,
    status: "error",
    mode,
    route: routeView(decision),
    decision: decision ? { allowed: false, action: decision.proposedAction, riskLevel: decision.riskLevel, requiresConfirmation: false } : null,
    result: { executed: false, summary: "Die Anfrage wurde nicht ausgefuehrt.", data: null },
    error: { code, message: internal ? "The router could not process the request." : (safePublicText(error?.message, 300) || "The router could not process the request."), retryable: error?.retryable === true, details: internal ? null : projectSafeDetails(error?.safeDetails) },
    meta: { durationMs, timestamp }
  };
}
