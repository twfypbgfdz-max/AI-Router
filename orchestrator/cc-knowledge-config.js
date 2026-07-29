// Independent schema/version counter for the CC-knowledge contract - never
// compared to cc-summary's "1.0", cc-status's "1.0" or the router API's
// "2.0". Same principle as every other contract in this repo: separate
// contracts, separate counters, never kept in sync.
export const CC_KNOWLEDGE_SCHEMA_VERSION = "1.0";

export const CC_KNOWLEDGE_MAX_QUESTION_CHARS = 500;

// A local index older than this is still used (DEC-003: last known-good
// state stays visible), but flagged with knowledgeState "index_stale"
// rather than silently treated as current. 24h matches a "re-index at most
// daily" operating rhythm for a manually-triggered, small allowlist.
export const CC_KNOWLEDGE_INDEX_MAX_AGE_MS = 24 * 60 * 60_000;

export const CC_KNOWLEDGE_STATES = Object.freeze(["ok", "partial", "unavailable"]);
// Commit C2b: the request-contract's context is either fully present or
// fully absent (normalizeCcKnowledgeRequest never returns a partial
// context) - "partial" is reserved for the response's systemContextState
// meaning, not a third contract-level shape, so the request-side enum
// deliberately stays two-valued.
export const CC_KNOWLEDGE_SYSTEM_CONTEXT_STATES = Object.freeze(["available", "unavailable"]);
export const CC_KNOWLEDGE_KNOWLEDGE_STATES = Object.freeze([
  "available", "no_match", "index_missing", "index_stale", "embedding_model_unavailable", "search_failed"
]);

// Commit C2b: response/route limits. Every value below either mirrors an
// existing cc-summary constant 1:1 in its own scope (timeout, rate,
// concurrency) or is a small, explicitly bounded new value (answer size,
// max sources/warnings) - no unrelated new parallel limit is introduced.
// NOTE (discovered while testing): the shared text-response pipeline
// already caps every provider answer at TEXT_RESPONSE_MAX_OUTPUT_TOKENS=800
// (~2400 bytes at its ~3-bytes-per-token estimator, enforced in
// text-response-service.js before this endpoint ever sees the text) - the
// same situation cc-summary-config.js documents for its own 2 KiB cap.
// 4096 is kept here exactly as specified and still enforced defensively in
// cc-knowledge-handler.js, but is currently unreachable in practice: an
// oversized answer is rejected earlier by the shared pipeline as
// PROVIDER_RESPONSE_INVALID / output_limit_exceeded (surfaced here as
// warning "model_response_invalid"), not as "model_answer_too_large".
export const CC_KNOWLEDGE_MAX_ANSWER_BYTES = 4096;
export const CC_KNOWLEDGE_NORMAL_TIMEOUT_MS = 20_000;
export const CC_KNOWLEDGE_ABSOLUTE_TIMEOUT_MS = 30_000;
export const CC_KNOWLEDGE_MAX_CONCURRENT_REQUESTS = 1;
export const CC_KNOWLEDGE_MAX_REQUESTS_PER_WINDOW = 1;
export const CC_KNOWLEDGE_MAX_SOURCES = 3;
export const CC_KNOWLEDGE_MAX_WARNINGS = 5;
// Same value as CC_SUMMARY_MAX_REQUEST_BYTES (cc-summary-config.js) - the
// request shapes are comparably small (a short question plus the same
// closed CC-status context), so the existing bound is reused rather than
// inventing a new one.
export const CC_KNOWLEDGE_MAX_REQUEST_BYTES = 16 * 1024;
