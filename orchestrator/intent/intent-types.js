// R2 - Intent Consolidation (Felix Core Foundation v2). The five intent
// classes this router distinguishes. These are the F4 draft classes, but
// they were not taken over blindly - they were checked against the real
// Jarvis routing seams (jarvis-console-proxy.js, jarvis-daily-intent.js,
// jarvis-today-handler.js, jarvis-system-handler.js, orchestrator/session/)
// before being adopted, and they matched what those seams already do
// implicitly. See intent-router.js for the classifier itself.
export const INTENT_TYPES = Object.freeze(["knowledge", "operational", "system", "action", "conversation"]);

export const INTENT_CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low"]);

export function isIntentType(value) {
  return INTENT_TYPES.includes(value);
}
