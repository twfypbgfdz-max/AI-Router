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
export const CC_KNOWLEDGE_SYSTEM_CONTEXT_STATES = Object.freeze(["available", "unavailable", "partial"]);
export const CC_KNOWLEDGE_KNOWLEDGE_STATES = Object.freeze([
  "available", "no_match", "index_missing", "index_stale", "embedding_model_unavailable", "search_failed"
]);
