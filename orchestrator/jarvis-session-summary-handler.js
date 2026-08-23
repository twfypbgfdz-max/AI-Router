import { readJsonBody, sendJson } from "./http-utils.js";
import { sessionStore as defaultSessionStore } from "./session/session-store.js";
import { buildSessionSummary } from "./session/session-summary.js";

const MAX_SESSION_SUMMARY_BODY_BYTES = 256;

// POST /api/jarvis/session/summary - M2 (Session Summary Layer, Felix Core
// Memory Ausbau). Read-only: never mutates, never expires, never evicts the
// session it summarizes - the session keeps living under its own R1 TTL
// exactly as if this endpoint had never been called (see
// session-store.js's getSession, which this handler reuses unchanged).
//
// Same trust level as /api/jarvis/ask (see server.js's isTrustedMutation
// gate on this route, and no bearer token here either): the content
// returned is exactly the same session content that already reached the
// browser turn by turn during the session itself via /api/jarvis/ask -
// asking for it as one summary exposes nothing new.
//
// Deliberately the entire M2 scope: a deterministic, on-request summary a
// person can read and decide about. It never writes to Obsidian/FELIX_SYSTEM,
// never triggers a second Ollama call, and never runs by itself - see
// DEC-003 (Datenlebenszyklus): this is the "Report/Analyse" stage, not
// "dauerhafte Dokumentation". Turning a returned summary into a permanent
// note remains a separate, manual, later decision by a person.
export function createJarvisSessionSummaryHandler({ sessionStore = defaultSessionStore } = {}) {
  return async function handleJarvisSessionSummary(request, response) {
    let sessionId = null;
    try {
      const body = await readJsonBody(request, MAX_SESSION_SUMMARY_BODY_BYTES);
      sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
    } catch {
      return sendJson(response, 400, {
        schemaVersion: "1.0",
        error: { code: "INVALID_REQUEST", message: "Request body must be valid JSON." }
      });
    }

    // An invalid, missing, unknown or expired sessionId is never an error
    // here - consistent with the rest of the R1 session route family: it
    // just means "nothing to summarize yet". A store failure degrades the
    // same way rather than surfacing as a 500 - there is nothing unsafe
    // about telling the caller "no summary" when the store is unavailable.
    let summary = null;
    try {
      const valid = sessionId && sessionStore.isValidSessionId(sessionId) ? sessionId : null;
      const session = valid ? sessionStore.getSession(valid) : null;
      summary = buildSessionSummary(session);
    } catch {
      summary = null;
    }

    return sendJson(response, 200, { schemaVersion: "1.0", summary });
  };
}

export const handleJarvisSessionSummary = createJarvisSessionSummaryHandler();
