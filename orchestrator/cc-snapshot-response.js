import { CC_SNAPSHOT_MAX_KNOWLEDGE_HITS, CC_SNAPSHOT_SCHEMA_VERSION } from "./cc-snapshot-config.js";

// Transport/auth/contract-layer failures (the request never reached ranking
// at all): same closed shape as cc-summary-response.js/cc-knowledge-response.js.
// VALIDATION_FAILED/SECURITY_BLOCKED are transport failures here too, same
// reasoning as cc-knowledge: ranking cannot even be computed from an invalid
// payload, so there is no partial "observation" to return.
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
  VALIDATION_FAILED: "The snapshot request is invalid.",
  SECURITY_BLOCKED: "The request cannot be processed.",
  INTERNAL_ERROR: "The snapshot request could not be completed."
});

export function buildCcSnapshotTransportFailure(error) {
  const code = TRANSPORT_ERROR_CODES.has(error?.code) ? error.code : "INTERNAL_ERROR";
  return {
    schemaVersion: CC_SNAPSHOT_SCHEMA_VERSION,
    error: { code, message: TRANSPORT_SAFE_MESSAGES[code] }
  };
}

export function ccSnapshotTransportHttpStatus(payload) {
  return TRANSPORT_HTTP_STATUS[payload?.error?.code] || 500;
}

const KNOWLEDGE_HIT_FIELDS = ["sourceDoc", "section", "docStatus", "docVersion", "similarity", "freshness"];

// Rebuilds each hit from only the fixed field list - same defensive close
// cc-knowledge-response.js applies to its `sources`, reused verbatim: the
// results handed in already come from the server's own validated RAG search
// (never from model text), but only these six fields can ever leave the
// process regardless of what shape the caller passed in.
function closedKnowledgeHit(hit) {
  const closed = {};
  for (const field of KNOWLEDGE_HIT_FIELDS) closed[field] = hit[field] ?? null;
  return Object.freeze(closed);
}

// The one, always-200 success shape once the request itself was valid:
// ranking is always present (pure computation, never fails); narrative
// degrades independently per its own state; knowledgeHits is empty exactly
// when no knowledgeQuery was supplied.
export function buildCcSnapshotResult({
  ranking,
  narrative,
  knowledgeHits = [],
  now = () => new Date()
} = {}) {
  return Object.freeze({
    schemaVersion: CC_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    ranking: Object.freeze({
      items: Object.freeze(ranking.items.map((item) => Object.freeze({ ...item }))),
      unranked: Object.freeze(ranking.unranked.map((item) => Object.freeze({ ...item })))
    }),
    narrative: Object.freeze({ ...narrative }),
    knowledgeHits: Object.freeze(knowledgeHits.slice(0, CC_SNAPSHOT_MAX_KNOWLEDGE_HITS).map(closedKnowledgeHit))
  });
}
