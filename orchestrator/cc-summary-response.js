import { CC_SUMMARY_SCHEMA_VERSION } from "./cc-summary-config.js";

// Transport/auth-layer failures (never reached the observe/state machine at
// all): a small, separate, closed shape - same style as cc-status-response.js.
const TRANSPORT_ERROR_CODES = new Set([
  "AUTH_REQUIRED", "AUTH_INVALID", "AUTH_NOT_CONFIGURED",
  "ORIGIN_NOT_ALLOWED", "METHOD_NOT_ALLOWED", "INTERNAL_ERROR"
]);
const TRANSPORT_HTTP_STATUS = Object.freeze({
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  AUTH_NOT_CONFIGURED: 503,
  ORIGIN_NOT_ALLOWED: 403,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_ERROR: 500
});
const TRANSPORT_SAFE_MESSAGES = Object.freeze({
  AUTH_REQUIRED: "Internal authentication is required.",
  AUTH_INVALID: "Internal authentication failed.",
  AUTH_NOT_CONFIGURED: "Internal authentication is unavailable.",
  ORIGIN_NOT_ALLOWED: "Browser-origin requests are not allowed.",
  METHOD_NOT_ALLOWED: "Method is not allowed.",
  INTERNAL_ERROR: "The summary request could not be completed."
});

export function buildCcSummaryTransportFailure(error) {
  const code = TRANSPORT_ERROR_CODES.has(error?.code) ? error.code : "INTERNAL_ERROR";
  return {
    schemaVersion: CC_SUMMARY_SCHEMA_VERSION,
    error: { code, message: TRANSPORT_SAFE_MESSAGES[code] }
  };
}

export function ccSummaryTransportHttpStatus(payload) {
  return TRANSPORT_HTTP_STATUS[payload?.error?.code] || 500;
}

// The one, always-closed observation shape. Every field is always present;
// summary/provider/model are populated only for state "ok", reason only for
// state "input_rejected" - never a raw exception, never provider output
// beyond the validated, length-capped summary text itself.
export function buildCcSummaryObservation({
  state,
  summary = null,
  provider = null,
  model = null,
  reason = null,
  now = () => new Date()
} = {}) {
  return Object.freeze({
    schemaVersion: CC_SUMMARY_SCHEMA_VERSION,
    mode: "observe",
    state,
    summary,
    provider,
    model,
    reason,
    generatedAt: now().toISOString()
  });
}

// Every "observe" outcome (including input_rejected) is a successfully
// handled request from the transport's point of view - only input_rejected
// gets a non-200 status, since that one is a genuine client-request problem.
export function ccSummaryObservationHttpStatus(state) {
  return state === "input_rejected" ? 422 : 200;
}
