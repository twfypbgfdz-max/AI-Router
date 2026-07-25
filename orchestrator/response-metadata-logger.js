const TOKEN = /^[A-Za-z0-9_.:-]{1,120}$/;
const ROUTES = new Set(["analysis", "content_generation", "general_chat", "knowledge_query", "planning"]);
const TASK_TYPES = new Set(["code", "research", "planning", "writing", "obsidian", "social_media", "learning", "career", "finance", "everyday", "unknown"]);
const SOURCES = new Set(["cockpit", "internal_test"]);
const STATUSES = new Set(["answered", "failed"]);
const RATE_DECISIONS = new Set(["allowed", "rejected", "not_checked"]);

function safeToken(value, maximum = 120) {
  return typeof value === "string" && value.length <= maximum && TOKEN.test(value) ? value : null;
}

function finite(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function createResponseMetadataLogger({ sink = (entry) => console.info(JSON.stringify(entry)) } = {}) {
  return Object.freeze({
    logOutcome(value = {}) {
      const entry = Object.freeze({
        event: "text_response_completed",
        requestId: safeToken(value.requestId),
        source: SOURCES.has(value.source) ? value.source : null,
        route: ROUTES.has(value.route) ? value.route : null,
        taskType: TASK_TYPES.has(value.taskType) ? value.taskType : null,
        providerId: value.providerId === "openai-text-v1" ? value.providerId : null,
        modelAlias: value.modelAlias === "configured-openai-text" ? value.modelAlias : null,
        durationMs: finite(value.durationMs),
        status: STATUSES.has(value.status) ? value.status : "failed",
        errorCode: safeToken(value.errorCode, 48),
        inputTokenEstimate: finite(value.inputTokenEstimate),
        providerInputTokens: finite(value.providerInputTokens),
        providerOutputTokens: finite(value.providerOutputTokens),
        calculatedCostUsd: finite(value.calculatedCostUsd),
        abortReason: safeToken(value.abortReason, 48),
        rateLimitDecision: RATE_DECISIONS.has(value.rateLimitDecision) ? value.rateLimitDecision : "not_checked"
      });
      try {
        const result = sink(entry);
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch {
        // Logging is metadata-only and must never break the response path.
      }
      return entry;
    }
  });
}

export const responseMetadataLogger = createResponseMetadataLogger();
