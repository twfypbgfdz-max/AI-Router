// R2 - Intent Consolidation (Felix Core Foundation v2). A small,
// deterministic routing layer: given a question (and optionally an already
// available session context or an explicit route context), decide which of
// the five intent classes it belongs to and, from that, which context
// sources are worth loading. Not a planner: exactly one primary intent per
// call, no workflow decomposition, no model call (R2 spec §3/§4/§21).
import { matchActionIntent, matchSystemIntent, matchOperationalIntent, matchConversationIntent, looksLikeReferenceQuestion } from "./intent-rules.js";

// Which context sources each intent is allowed to draw on - derived from
// the providers already wired into jarvis-console-proxy.js and
// knowledge-service.js today, not invented for R2. "session" is true for
// every intent because R1's session context may always help resolve a
// reference in the question (buildSessionContext() already guarantees it
// is never authoritative on its own - see knowledge-answer-prompt.js's
// SESSION_CONTEXT_RULE); it is only the *primary* source for "conversation".
export const INTENT_CONTEXT_POLICY = Object.freeze({
  knowledge: Object.freeze({ session: true, rag: true, operational: false, system: false }),
  operational: Object.freeze({ session: true, rag: false, operational: true, system: false }),
  system: Object.freeze({ session: true, rag: false, operational: false, system: true }),
  action: Object.freeze({ session: true, rag: false, operational: false, system: false }),
  conversation: Object.freeze({ session: true, rag: true, operational: true, system: false })
});

function classified(intent, confidence, reason) {
  return Object.freeze({ intent, confidence, reason });
}

// Priority order, matching R2 spec §4 exactly:
//   1. explicit route context - the caller already knows what this request
//      is (e.g. the fixed /api/jarvis/today or /api/jarvis/system routes),
//      so no text has to be guessed at at all.
//   2. deterministic rules, in this specific order: action, then
//      operational, then system. Action must run before operational
//      because an action-verb question like "Lösch meine Aufgaben" would
//      otherwise also match operational's "meine Aufgaben" pattern (R2
//      spec §15) - action is the more specific, higher-consequence read.
//   3. the session-context-dependent conversation pattern - only ever
//      considered with an active session, never guessed without one (§7).
//   4. knowledge - the historical default for every other question, exactly
//      what asking the knowledge engine directly already meant before R2.
export function classifyIntent({ question, sessionContext = null, routeContext = null } = {}) {
  if (routeContext?.route === "today") {
    return classified("operational", "high", "explicit route: /api/jarvis/today");
  }
  if (routeContext?.route === "system") {
    return classified("system", "high", "explicit route: /api/jarvis/system");
  }

  if (matchActionIntent(question)) {
    return classified("action", "high", "explicit action verb pattern");
  }

  if (matchOperationalIntent(question)) {
    return classified("operational", "high", "daily/task/calendar pattern (jarvis-daily-intent)");
  }

  if (matchSystemIntent(question)) {
    return classified("system", "high", "live system/runtime state pattern");
  }

  if (matchConversationIntent(question, sessionContext)) {
    return classified("conversation", "medium", "reference/follow-up pattern with active session");
  }

  // Looks like a follow-up (bare "Warum?", "der zweite", "davor"...) but no
  // session is available to resolve it against - still knowledge (the same
  // fallback every other unmatched question gets), but explicitly
  // low-confidence rather than guessed as conversation (R2 spec §7: "nicht
  // halluzinieren").
  if (looksLikeReferenceQuestion(question)) {
    return classified("knowledge", "low", "reference-shaped question without an active session - degraded, not guessed");
  }

  if (typeof question === "string" && question.trim()) {
    return classified("knowledge", "medium", "no operational/system/action/conversation signal - default to knowledge");
  }

  return classified("knowledge", "low", "empty or non-string question - degraded default");
}
