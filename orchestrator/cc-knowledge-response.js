import {
  CC_KNOWLEDGE_MAX_SOURCES,
  CC_KNOWLEDGE_MAX_WARNINGS,
  CC_KNOWLEDGE_SCHEMA_VERSION
} from "./cc-knowledge-config.js";

// Transport/auth/contract-layer failures (the request never reached the
// knowledge-answering logic at all): a small, separate, closed shape - same
// style as cc-summary-response.js and cc-status-response.js. Per the C2b
// architecture decision, contract validation failures (VALIDATION_FAILED,
// SECURITY_BLOCKED) are transport failures here, not part of the
// state:ok/partial/unavailable observation envelope - the observation
// envelope is reserved for requests that were valid and actually processed.
const TRANSPORT_ERROR_CODES = new Set([
  "AUTH_REQUIRED", "AUTH_INVALID", "AUTH_NOT_CONFIGURED",
  "ORIGIN_NOT_ALLOWED", "METHOD_NOT_ALLOWED",
  "VALIDATION_FAILED", "SECURITY_BLOCKED", "INTERNAL_ERROR"
]);
const TRANSPORT_HTTP_STATUS = Object.freeze({
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  AUTH_NOT_CONFIGURED: 503,
  ORIGIN_NOT_ALLOWED: 403,
  METHOD_NOT_ALLOWED: 405,
  VALIDATION_FAILED: 422,
  SECURITY_BLOCKED: 403,
  INTERNAL_ERROR: 500
});
const TRANSPORT_SAFE_MESSAGES = Object.freeze({
  AUTH_REQUIRED: "Internal authentication is required.",
  AUTH_INVALID: "Internal authentication failed.",
  AUTH_NOT_CONFIGURED: "Internal authentication is unavailable.",
  ORIGIN_NOT_ALLOWED: "Browser-origin requests are not allowed.",
  METHOD_NOT_ALLOWED: "Method is not allowed.",
  VALIDATION_FAILED: "The knowledge request is invalid.",
  SECURITY_BLOCKED: "The request cannot be processed.",
  INTERNAL_ERROR: "The knowledge request could not be completed."
});

export function buildCcKnowledgeTransportFailure(error) {
  const code = TRANSPORT_ERROR_CODES.has(error?.code) ? error.code : "INTERNAL_ERROR";
  return {
    schemaVersion: CC_KNOWLEDGE_SCHEMA_VERSION,
    error: { code, message: TRANSPORT_SAFE_MESSAGES[code] }
  };
}

export function ccKnowledgeTransportHttpStatus(payload) {
  return TRANSPORT_HTTP_STATUS[payload?.error?.code] || 500;
}

const SOURCE_FIELDS = ["sourceDoc", "section", "docStatus", "docVersion", "similarity", "freshness"];

// Rebuilds each source from only the fixed field list, discarding anything
// else - the source objects handed in already come from the server's own
// validated RAG results (never from model text), but this is a second,
// defensive close: only these six fields can ever leave the process as a
// "source", regardless of what shape the caller passed in.
function closedSource(source) {
  const closed = {};
  for (const field of SOURCE_FIELDS) closed[field] = source[field] ?? null;
  return Object.freeze(closed);
}

// The one, always-closed observation shape, used only for requests whose
// contract validation already succeeded. Every field is always present.
// answer is non-null exactly when state is "ok" or "partial", and null
// exactly when state is "unavailable" - enforced here, not left to the
// caller to get right.
export function buildCcKnowledgeObservation({
  state,
  answer = null,
  systemContextState,
  knowledgeState,
  sources = [],
  warnings = [],
  now = () => new Date()
} = {}) {
  const isUnavailable = state === "unavailable";
  if (isUnavailable && answer !== null) {
    throw new Error("Internal error: an unavailable knowledge response must not carry an answer.");
  }
  if (!isUnavailable && (typeof answer !== "string" || !answer.trim())) {
    throw new Error("Internal error: a produced knowledge response must carry a non-empty answer.");
  }
  const closedSources = sources.slice(0, CC_KNOWLEDGE_MAX_SOURCES).map(closedSource);
  const closedWarnings = Object.freeze(warnings.slice(0, CC_KNOWLEDGE_MAX_WARNINGS));

  return Object.freeze({
    schemaVersion: CC_KNOWLEDGE_SCHEMA_VERSION,
    state,
    answer,
    systemContextState,
    knowledgeState,
    sources: Object.freeze(closedSources),
    warnings: closedWarnings,
    generatedAt: now().toISOString()
  });
}

// state itself is never mapped to a non-200 status - differentiation lives
// in the body (state/warnings), matching cc-summary's philosophy that
// "the request was validly processed" is a transport-level 200 regardless
// of the business outcome. The one deliberate exception: this endpoint's
// own scoped rate/concurrency limiter (not a business state) still needs a
// real 429 for well-behaved retry clients, signaled here via warnings
// rather than by adding a fourth state value to the fixed ok/partial/
// unavailable enum.
export function ccKnowledgeObservationHttpStatus(warnings = []) {
  if (warnings.includes("rate_limited") || warnings.includes("concurrency_limited")) return 429;
  return 200;
}
