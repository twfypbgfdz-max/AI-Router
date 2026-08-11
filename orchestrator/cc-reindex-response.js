import { CC_REINDEX_SCHEMA_VERSION } from "./cc-reindex-config.js";
import { RAG_ERROR_CODES } from "./knowledge/rag-error.js";

const ERROR_CODES = new Set([
  "AUTH_REQUIRED", "AUTH_INVALID", "AUTH_NOT_CONFIGURED", "ORIGIN_NOT_ALLOWED",
  "METHOD_NOT_ALLOWED", "RATE_LIMITED", "CONCURRENCY_LIMITED", "REINDEX_FAILED",
  "INTERNAL_ERROR"
]);
const HTTP_STATUS = Object.freeze({
  AUTH_REQUIRED: 403,
  AUTH_INVALID: 403,
  AUTH_NOT_CONFIGURED: 503,
  ORIGIN_NOT_ALLOWED: 403,
  METHOD_NOT_ALLOWED: 405,
  RATE_LIMITED: 429,
  CONCURRENCY_LIMITED: 429,
  REINDEX_FAILED: 502,
  INTERNAL_ERROR: 500
});
const SAFE_MESSAGES = Object.freeze({
  AUTH_REQUIRED: "Internal authentication is required.",
  AUTH_INVALID: "Internal authentication failed.",
  AUTH_NOT_CONFIGURED: "Internal authentication is unavailable.",
  ORIGIN_NOT_ALLOWED: "Browser-origin requests are not allowed.",
  METHOD_NOT_ALLOWED: "Method is not allowed.",
  RATE_LIMITED: "The internal request rate limit was exceeded.",
  CONCURRENCY_LIMITED: "The concurrent reindex limit was exceeded.",
  REINDEX_FAILED: "The reindex run could not be completed.",
  INTERNAL_ERROR: "The reindex request could not be completed."
});

// Success payload has no top-level "status" field by design, same as every
// other CC contract in this repo - only failure responses carry
// status: "failed". documentsRejectedFromAllowlist entries only ever carry
// a vault-relative path (from Felix's own reviewed allowlist file) and a
// closed RagError code - never a message built from external input.
export function buildCcReindexSuccess(result, { generatedAt }) {
  return {
    schemaVersion: CC_REINDEX_SCHEMA_VERSION,
    generatedAt,
    documentsProcessed: result.documentsProcessed,
    documentsRejectedFromAllowlist: result.documentsRejectedFromAllowlist.map((entry) => ({
      relativePath: entry.relativePath,
      code: entry.code
    })),
    chunkCount: result.chunkCount,
    forceFullReindex: result.forceFullReindex,
    error: null
  };
}

// reason, when present, is always one of the closed RAG_ERROR_CODES - never
// the underlying error.message or any safeDetails, so a future RagError
// call site can never leak a path, a document title or other document
// content into this response by accident.
export function buildCcReindexFailure(error, { generatedAt }) {
  const code = ERROR_CODES.has(error?.code) ? error.code : "INTERNAL_ERROR";
  const reason = code === "REINDEX_FAILED" && RAG_ERROR_CODES.includes(error?.reason) ? error.reason : null;
  return {
    schemaVersion: CC_REINDEX_SCHEMA_VERSION,
    generatedAt,
    status: "failed",
    error: {
      code,
      message: SAFE_MESSAGES[code],
      retryable: error?.retryable === true,
      reason
    }
  };
}

export function ccReindexHttpStatus(payload) {
  return HTTP_STATUS[payload?.error?.code] || 500;
}

export const ccReindexErrorCodes = Object.freeze([...ERROR_CODES]);
