import { CC_STATUS_SCHEMA_VERSION } from "./cc-status-config.js";

const ERROR_CODES = new Set([
  "AUTH_REQUIRED", "AUTH_INVALID", "AUTH_NOT_CONFIGURED", "ORIGIN_NOT_ALLOWED",
  "METHOD_NOT_ALLOWED", "UPSTREAM_UNAVAILABLE", "INTERNAL_ERROR"
]);
const HTTP_STATUS = Object.freeze({
  AUTH_REQUIRED: 403,
  AUTH_INVALID: 403,
  ORIGIN_NOT_ALLOWED: 403,
  METHOD_NOT_ALLOWED: 405,
  AUTH_NOT_CONFIGURED: 503,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500
});
const SAFE_MESSAGES = Object.freeze({
  AUTH_REQUIRED: "Internal authentication is required.",
  AUTH_INVALID: "Internal authentication failed.",
  AUTH_NOT_CONFIGURED: "Internal authentication is unavailable.",
  ORIGIN_NOT_ALLOWED: "Browser-origin requests are not allowed.",
  METHOD_NOT_ALLOWED: "Method is not allowed.",
  UPSTREAM_UNAVAILABLE: "Router status data is temporarily unavailable.",
  INTERNAL_ERROR: "The status request could not be completed."
});

// Success payload has no top-level "status" field by design — only failure
// responses carry status: "failed". This mirrors the agreed contract exactly.
export function buildCcStatusSuccess(data, { generatedAt }) {
  return {
    schemaVersion: CC_STATUS_SCHEMA_VERSION,
    generatedAt,
    routerVersion: data.routerVersion,
    routerStatus: data.routerStatus,
    activeModes: [...data.activeModes],
    providers: data.providers.map((provider) => ({ ...provider })),
    usage: { ...data.usage },
    error: null
  };
}

export function buildCcStatusFailure(error, { generatedAt }) {
  const code = ERROR_CODES.has(error?.code) ? error.code : "INTERNAL_ERROR";
  return {
    schemaVersion: CC_STATUS_SCHEMA_VERSION,
    generatedAt,
    status: "failed",
    error: {
      code,
      message: SAFE_MESSAGES[code],
      retryable: error?.retryable === true
    }
  };
}

export function ccStatusHttpStatus(payload) {
  return HTTP_STATUS[payload?.error?.code] || 500;
}

export const ccStatusErrorCodes = Object.freeze([...ERROR_CODES]);
