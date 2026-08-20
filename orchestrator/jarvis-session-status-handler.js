import { sendJson } from "./http-utils.js";
import { sessionStore as defaultSessionStore } from "./session/session-store.js";

// GET /api/jarvis/session-status - R1 (Session/Context Manager), local
// diagnostic only. Same trust level as /api/jarvis/ready and
// /api/jarvis/system: read-only, no token. Deliberately exposes counts and
// the closed limit set only - never a sessionId, a question, an answer, or
// any other session content, matching the diagnostic-metadata-only
// convention already used for logging (see knowledge-handler.js's
// safeLog).
export function createJarvisSessionStatusHandler({ sessionStore = defaultSessionStore } = {}) {
  return async function handleJarvisSessionStatus(request, response) {
    sendJson(response, 200, {
      schemaVersion: "1.0",
      activeSessions: sessionStore.activeSessionCount(),
      limits: {
        maxTurns: sessionStore.limits.maxTurns,
        maxTurnChars: sessionStore.limits.maxTurnChars,
        contextTurns: sessionStore.limits.contextTurns,
        idleTtlMs: sessionStore.limits.idleTtlMs,
        maxSessionAgeMs: sessionStore.limits.maxSessionAgeMs,
        maxConcurrentSessions: sessionStore.limits.maxConcurrentSessions
      }
    });
  };
}

export const handleJarvisSessionStatus = createJarvisSessionStatusHandler();
