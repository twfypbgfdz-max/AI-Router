import {
  CONTEXT_TURNS,
  IDLE_TTL_MS,
  MAX_CONCURRENT_SESSIONS,
  MAX_SESSION_AGE_MS,
  MAX_TURNS,
  MAX_TURN_CHARS
} from "./session-limits.js";

// The Session Manager v1 store (R1, Felix Core Foundation v2). RAM-only, by
// design (F4 §8, §15): no database, no file persistence, no rehydration
// after a process restart - a restart losing every session is an accepted,
// deliberate property, not a defect. This module owns exactly session
// lifecycle and turn storage; it never builds a prompt and never talks to
// a model - that split lives in session-context.js.
//
// sessionId is client-generated (the Jarvis page mints one per page load,
// see jarvis-console.html) and is validated here for FORM ONLY: a closed
// character set and a bounded length. Nothing about it is ever interpreted
// as a path, a lookup key into anything but this in-memory Map, or
// personal data - an invalid or missing ID never becomes a request error,
// it just means "no session", consistent with the rest of this route's
// fail-closed-but-never-hard-fails-on-optional-input posture.
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,100}$/;

export function isValidSessionId(sessionId) {
  return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId);
}

function truncate(text, maxChars) {
  const value = typeof text === "string" ? text : "";
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function isExpired(session, now, limits) {
  return (now - session.updatedAt > limits.idleTtlMs) || (now - session.createdAt > limits.maxSessionAgeMs);
}

// A session created by createSessionStore is not itself exported - every
// caller goes through the functions below, so expiry/eviction is always
// applied consistently rather than left to each call site to remember.
export function createSessionStore({
  now = () => Date.now(),
  maxTurns = MAX_TURNS,
  maxTurnChars = MAX_TURN_CHARS,
  contextTurns = CONTEXT_TURNS,
  idleTtlMs = IDLE_TTL_MS,
  maxSessionAgeMs = MAX_SESSION_AGE_MS,
  maxConcurrentSessions = MAX_CONCURRENT_SESSIONS
} = {}) {
  const limits = Object.freeze({ maxTurns, maxTurnChars, contextTurns, idleTtlMs, maxSessionAgeMs, maxConcurrentSessions });
  const sessions = new Map();
  // Serializes turn writes per session (§11): two near-simultaneous
  // requests carrying the same sessionId must never interleave their
  // pushes into `turns`. A plain Map of promise chains is enough for a
  // single-process, single-person system - no distributed queue needed.
  const writeLocks = new Map();

  function evictIfExpired(sessionId, session, t) {
    if (isExpired(session, t, limits)) {
      sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  // Lazy cleanup only (§6): no background timer. Expired sessions are
  // reaped whenever the store is touched, not on a schedule.
  function pruneExpired(t) {
    for (const [id, session] of sessions) evictIfExpired(id, session, t);
  }

  function evictOldestIfOverCapacity() {
    if (sessions.size <= limits.maxConcurrentSessions) return;
    let oldestId = null;
    let oldestUpdatedAt = Infinity;
    for (const [id, session] of sessions) {
      if (session.updatedAt < oldestUpdatedAt) {
        oldestUpdatedAt = session.updatedAt;
        oldestId = id;
      }
    }
    if (oldestId !== null) sessions.delete(oldestId);
  }

  // Read-only lookup: never creates a session. Returns null for a missing,
  // invalid, or expired session id - the caller (session-context.js /
  // jarvis-console-proxy.js) treats null as "no context", never as an
  // error.
  function getSession(sessionId, t = now()) {
    if (!isValidSessionId(sessionId)) return null;
    pruneExpired(t);
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (evictIfExpired(sessionId, session, t)) return null;
    return session;
  }

  function createSession(sessionId, t) {
    const session = { sessionId, createdAt: t, updatedAt: t, turns: [] };
    sessions.set(sessionId, session);
    evictOldestIfOverCapacity();
    return session;
  }

  // Appends one user+assistant turn to a session, creating it if it does
  // not exist yet or reviving a fresh one under the same id if the
  // previous one expired (F4 §8 "Neustart"/"Fehler": session loss never
  // surfaces as an error, it just starts a new session transparently).
  //
  // Deliberately only called after a successful, fully-answered request
  // (see jarvis-console-proxy.js) - a validation failure or a provider
  // outage never reaches this function, so a session's turn history only
  // ever contains real question/answer pairs, never an error message.
  async function appendTurn(sessionId, { question, answer }, t = now()) {
    if (!isValidSessionId(sessionId)) return null;
    // Chained off the previous write for this session, never off a
    // rejected promise: every entry stored back into writeLocks below is
    // pre-caught, so `previous` here is always a promise that resolves -
    // one broken write can therefore never wedge every later write for the
    // same session behind it.
    const previous = writeLocks.get(sessionId) || Promise.resolve();
    const run = previous.then(() => {
      pruneExpired(t);
      const existing = sessions.get(sessionId);
      const session = (existing && !evictIfExpired(sessionId, existing, t)) ? existing : createSession(sessionId, t);
      session.turns.push({
        question: truncate(question, limits.maxTurnChars),
        answer: truncate(answer, limits.maxTurnChars),
        at: new Date(t).toISOString()
      });
      if (session.turns.length > limits.maxTurns) {
        session.turns.splice(0, session.turns.length - limits.maxTurns);
      }
      session.updatedAt = t;
      return session;
    });
    writeLocks.set(sessionId, run.catch(() => {}));
    return run;
  }

  return Object.freeze({
    getSession,
    appendTurn,
    isValidSessionId,
    limits,
    // Diagnostics-only (see jarvis-session-status-handler.js): counts, no
    // session content.
    activeSessionCount: (t = now()) => { pruneExpired(t); return sessions.size; }
  });
}

// One process-wide singleton, exactly like handleKnowledgeRequest and
// other module-level singletons in this repo - jarvis-console-proxy.js
// imports this directly; only tests build their own instance via
// createSessionStore() to control `now` and get isolation between test
// cases.
export const sessionStore = createSessionStore();
