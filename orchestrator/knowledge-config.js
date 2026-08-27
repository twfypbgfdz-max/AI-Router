// Independent schema/version counter for the generic knowledge contract -
// never compared to CC_KNOWLEDGE_SCHEMA_VERSION, cc-summary's "1.0" or the
// router API's "2.0". It starts at the same value as the Command Center
// contract by coincidence, not by coupling: the two are separate contracts
// with separate counters and are never kept in sync.
export const KNOWLEDGE_SCHEMA_VERSION = "1.0";

// Name only. The value is never read here, never logged, never written to a
// file and never printed - it exists exclusively as a Windows user
// environment variable, the same way AI_ROUTER_CC_TOKEN and
// AI_ROUTER_INTERNAL_TOKEN already do.
//
// Deliberately a SEPARATE token from AI_ROUTER_CC_TOKEN rather than a
// shared one: this route is the multi-consumer, read-only path, and a
// consumer of it must not thereby gain access to the Command Center's
// /api/v1/cc/* routes (summary, snapshot, status, reindex - the last of
// which is state-changing). Separate tokens keep "may ask the vault a
// question" strictly weaker than "is the Command Center".
export const KNOWLEDGE_TOKEN_ENV_VAR = "AI_ROUTER_KNOWLEDGE_TOKEN";

// Mirrors CC_KNOWLEDGE_MAX_QUESTION_CHARS. Kept as its own constant rather
// than imported so the two contracts can diverge without one silently
// dragging the other along.
export const KNOWLEDGE_MAX_QUESTION_CHARS = 500;
export const KNOWLEDGE_MAX_REQUEST_BYTES = 16 * 1024;
export const KNOWLEDGE_ABSOLUTE_TIMEOUT_MS = 30_000;

// Same deliberately tight budget as the Command Center path, but a separate
// counter: each consumer builds its own knowledge service and therefore its
// own in-memory limiter, so one consumer can never exhaust the other's
// allowance. One request per 60 seconds is a real constraint a UI on this
// route has to surface honestly rather than hide behind a spinner.
//
// Governs POST /api/v1/knowledge only (server.js's own singleton). Left
// untouched by the Jarvis-specific budget below.
export const KNOWLEDGE_MAX_CONCURRENT_REQUESTS = 1;
export const KNOWLEDGE_MAX_REQUESTS_PER_WINDOW = 1;

// Real-usage finding (2026-08-27): a 60s cooldown on the human-facing /jarvis
// console felt punitive, and the UI's own countdown text had drifted from
// what the shared knowledge-route limiter actually enforced. Jarvis gets its
// own, independent budget instead of a shorter shared one, specifically so
// /api/v1/knowledge's real limit (above) and cc/knowledge's stay exactly
// what they were. Still one concurrent request and one request per window -
// only the window itself is shorter, matched to a single human asking
// follow-up questions rather than to a script.
export const JARVIS_ASK_MAX_CONCURRENT_REQUESTS = 1;
export const JARVIS_ASK_MAX_REQUESTS_PER_WINDOW = 1;
export const JARVIS_ASK_RATE_WINDOW_MS = 5_000;
