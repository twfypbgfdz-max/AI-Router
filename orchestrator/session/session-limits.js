// Central, closed set of Session-Manager v1 limits (R1, Felix Core
// Foundation v2). Every module under orchestrator/session/ imports its
// numbers from here rather than repeating a literal, so a future tuning
// pass touches exactly one file.
//
// A "turn" here is one user+assistant pairing (one question, one answer),
// not one message - chosen over "one message = one turn" because every
// limit below (MAX_TURNS, CONTEXT_TURNS) is more naturally expressed as a
// number of exchanges than as a number of individual lines, and because
// the caller (jarvis-console-proxy.js) always has exactly a question and
// an answer available together at the one point it writes a turn.

// How many turns a session may hold before the oldest are dropped
// entirely. 20 real exchanges is enough for a genuine conversation while
// keeping the per-session memory footprint small and bounded.
export const MAX_TURNS = 20;

// Character cap applied independently to a turn's stored question text and
// its stored answer text (not their combined length) - consistent with the
// existing MAX_*_CHARS convention elsewhere in the repo (e.g.
// KNOWLEDGE_MAX_QUESTION_CHARS in knowledge-config.js), which always caps
// one field, never a sum of fields. A turn exceeding this is truncated,
// never rejected - session storage must never turn a successfully answered
// question into a hard failure.
export const MAX_TURN_CHARS = 2_000;

// How many of the most recent turns are rendered verbatim into the prompt
// per request. Older turns are folded into one deterministic summary line
// instead of being dropped outright (see session-context.js).
export const CONTEXT_TURNS = 6;

// A session with no activity for this long is treated as expired on its
// next access and silently replaced by a fresh session under the same ID -
// never an error (see session-store.js).
export const IDLE_TTL_MS = 15 * 60 * 1000;

// Hard ceiling on a session's lifetime regardless of activity, so a
// forgotten open tab cannot keep growing a session indefinitely.
export const MAX_SESSION_AGE_MS = 2 * 60 * 60 * 1000;

// Defensive cap on how many sessions may exist in the process at once
// (F4 §8: "Schutz gegen Ressourcenerschöpfung bei mehreren offenen
// Tabs/Geräten" for a single-person system). Lazy per-access cleanup alone
// does not bound memory for sessions nobody revisits, so a new session
// beyond this cap evicts the least-recently-updated existing one.
export const MAX_CONCURRENT_SESSIONS = 20;
