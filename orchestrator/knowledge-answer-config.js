// Constants for the shared knowledge-answering engine
// (knowledge-service.js, knowledge-answer-rag-service.js,
// knowledge-answer-response.js) - the part both cc/knowledge and
// v1/knowledge actually run through. Split out of the former
// cc-knowledge-config.js on 2026-08-12: those four values were never
// Command-Center-specific policy, they were the shared engine's own limits
// that the generic route happened to import from a "cc-" named file. The
// genuinely CC-route-specific settings (its own schema version, question
// length, rate/concurrency budget, request size) remain in
// cc-knowledge-config.js.

// A local index older than this is still used (DEC-003: last known-good
// state stays visible), but flagged with knowledgeState "index_stale"
// rather than silently treated as current. 24h matches a "re-index at most
// daily" operating rhythm for a manually-triggered, small allowlist.
export const KNOWLEDGE_ANSWER_INDEX_MAX_AGE_MS = 24 * 60 * 60_000;

// NOTE (discovered while testing): the shared text-response pipeline
// already caps every provider answer at TEXT_RESPONSE_MAX_OUTPUT_TOKENS=800
// (~2400 bytes at its ~3-bytes-per-token estimator, enforced in
// text-response-service.js before this engine ever sees the text) - the
// same situation cc-summary-config.js documents for its own 2 KiB cap.
// 4096 is kept here exactly as specified and still enforced defensively in
// knowledge-service.js, but is currently unreachable in practice: an
// oversized answer is rejected earlier by the shared pipeline as
// PROVIDER_RESPONSE_INVALID / output_limit_exceeded (surfaced as warning
// "model_response_invalid"), not as "model_answer_too_large".
export const KNOWLEDGE_ANSWER_MAX_BYTES = 4096;

export const KNOWLEDGE_ANSWER_MAX_SOURCES = 3;
export const KNOWLEDGE_ANSWER_MAX_WARNINGS = 5;
