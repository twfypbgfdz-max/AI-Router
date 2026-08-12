// CC-route-specific settings for POST /api/v1/cc/knowledge only: its own
// contract shape (schema version, question length) and its own rate/
// concurrency/request-size budget. The engine-level limits that used to
// live in this file too (answer size, index staleness, source/warning
// caps) moved to knowledge-answer-config.js on 2026-08-12 - they were never
// CC-specific, the generic /api/v1/knowledge route ran through them from
// day one via the shared knowledge-service.js, just under a misleadingly
// "cc-" named import.
//
// Independent schema/version counter for the CC-knowledge contract - never
// compared to cc-summary's "1.0", cc-status's "1.0" or the router API's
// "2.0". Same principle as every other contract in this repo: separate
// contracts, separate counters, never kept in sync.
export const CC_KNOWLEDGE_SCHEMA_VERSION = "1.0";

export const CC_KNOWLEDGE_MAX_QUESTION_CHARS = 500;

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

// Commit C2b: route limits. Every value below either mirrors an existing
// cc-summary constant 1:1 in its own scope (timeout, rate, concurrency) or
// is a small, explicitly bounded new value - no unrelated new parallel
// limit is introduced.
export const CC_KNOWLEDGE_NORMAL_TIMEOUT_MS = 20_000;
export const CC_KNOWLEDGE_ABSOLUTE_TIMEOUT_MS = 30_000;
export const CC_KNOWLEDGE_MAX_CONCURRENT_REQUESTS = 1;
export const CC_KNOWLEDGE_MAX_REQUESTS_PER_WINDOW = 1;
// Same value as CC_SUMMARY_MAX_REQUEST_BYTES (cc-summary-config.js) - the
// request shapes are comparably small (a short question plus the same
// closed CC-status context), so the existing bound is reused rather than
// inventing a new one.
export const CC_KNOWLEDGE_MAX_REQUEST_BYTES = 16 * 1024;
