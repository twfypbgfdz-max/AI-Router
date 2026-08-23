// Session Summary Layer v1 (M2, Felix Core Memory Ausbau). Turns a stored
// session (session-store.js) into a deterministic, read-only summary that a
// person can review and decide about - manually, outside this system -
// whether anything in it is worth keeping long-term. This module never
// writes anywhere, never calls a model, and never runs on its own: it only
// ever runs in response to an explicit request (see
// jarvis-session-summary-handler.js).
//
// This is the "Report / Analyse" stage of DEC-003's Datenlebenszyklus, not
// "dauerhafte Dokumentation" - producing this object is not itself
// long-term memory. Turning it into a permanent note is a separate, later,
// manual decision this module does not make and does not know happened.
//
// Pure function of whatever session-store.js already handed it, exactly
// like session-context.js - never touches the store itself.
export function buildSessionSummary(session, { now = () => Date.now() } = {}) {
  if (!session || !Array.isArray(session.turns) || session.turns.length === 0) return null;
  return Object.freeze({
    sessionId: session.sessionId,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    turnCount: session.turns.length,
    turns: Object.freeze(session.turns.map((turn) => ({ question: turn.question, answer: turn.answer, at: turn.at }))),
    generatedAt: new Date(now()).toISOString()
  });
}
