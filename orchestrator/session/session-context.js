// Turns a stored session (session-store.js) into the small, structured
// object knowledge-answer-prompt.js renders as the GESPRÄCHSVERLAUF prompt
// block. This module never touches the store and never calls a model - it
// is a pure function of whatever session-store.js already handed it.
//
// F4 §8 explicitly rules out a second Ollama call just to summarize older
// turns ("Keinen zweiten Ollama-Aufruf pro Request nur für Session Summary
// einführen"). The summary below is therefore fully deterministic: the
// questions from the turns older than the visible window, listed in order.
// It intentionally does not attempt to paraphrase or interpret - only to
// keep enough of "what was asked before" that a pronoun like "der zweite
// Punkt" still resolves, which is the one job session context is allowed
// to do (see the SESSION_CONTEXT_RULE in knowledge-answer-prompt.js: it is
// never authoritative and never a citable source).
import { CONTEXT_TURNS } from "./session-limits.js";

function buildSummary(olderTurns) {
  if (olderTurns.length === 0) return null;
  const questions = olderTurns.map((turn) => turn.question).filter(Boolean);
  if (questions.length === 0) return null;
  return `Vorherige Fragen dieser Sitzung: ${questions.join(" / ")}`;
}

// session may be null (no sessionId, unknown id, or an expired session
// that session-store.js already dropped) - that is not an error, it just
// means "no context to add", so this returns null rather than throwing.
export function buildSessionContext(session, { contextTurns = CONTEXT_TURNS } = {}) {
  if (!session || !Array.isArray(session.turns) || session.turns.length === 0) return null;
  const turns = session.turns;
  const recentTurns = turns.slice(Math.max(0, turns.length - contextTurns)).map((turn) => ({
    question: turn.question,
    answer: turn.answer
  }));
  const olderTurns = turns.slice(0, Math.max(0, turns.length - contextTurns));
  return Object.freeze({
    summary: buildSummary(olderTurns),
    recentTurns: Object.freeze(recentTurns)
  });
}
