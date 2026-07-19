import { RECOMMENDATION_SCHEMA_VERSION } from "./config.js";
import { ERROR_CODES } from "./policy.js";
import { routerHttpStatus } from "./router-response.js";

const SAFE_MESSAGES = Object.freeze({
  INVALID_REQUEST: "Recommendation input must be a JSON object.",
  UNSUPPORTED_SCHEMA_VERSION: "Unsupported recommendation schema version.",
  VALIDATION_FAILED: "Recommendation input validation failed.",
  PAYLOAD_TOO_LARGE: "Recommendation input exceeds a configured limit.",
  EXECUTION_DISABLED: "Recommendation mode must remain observe.",
  ORIGIN_NOT_ALLOWED: "Origin is not allowed.",
  TIMEOUT: "Recommendation request timed out.",
  INTERNAL_ERROR: "The recommendation engine could not process the request."
});

export function buildRecommendationFailure(error, { generatedAt = new Date().toISOString() } = {}) {
  const candidate = ERROR_CODES.includes(error?.code) ? error.code : "INTERNAL_ERROR";
  const code = Object.hasOwn(SAFE_MESSAGES, candidate) ? candidate : "INTERNAL_ERROR";
  return {
    schemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    mode: "observe",
    generatedAt,
    recommendation: null,
    alternatives: [],
    blockedReasons: [code],
    missingEvidence: [],
    execution: { allowed: false, performed: false },
    error: { code, message: SAFE_MESSAGES[code] }
  };
}

export function recommendationHttpStatus(payload) {
  return routerHttpStatus(payload?.error?.code);
}
