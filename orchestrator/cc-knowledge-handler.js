import { readJsonBody } from "./http-utils.js";
import { authenticateInternalRequest } from "./internal-auth.js";
import { CcKnowledgeError } from "./cc-knowledge-error.js";
import { normalizeCcKnowledgeRequest } from "./cc-knowledge-contract.js";
import {
  buildCcKnowledgeTransportFailure,
  ccKnowledgeObservationHttpStatus,
  ccKnowledgeTransportHttpStatus
} from "./cc-knowledge-response.js";
import {
  CC_KNOWLEDGE_ABSOLUTE_TIMEOUT_MS,
  CC_KNOWLEDGE_MAX_CONCURRENT_REQUESTS,
  CC_KNOWLEDGE_MAX_REQUEST_BYTES,
  CC_KNOWLEDGE_MAX_REQUESTS_PER_WINDOW
} from "./cc-knowledge-config.js";
import { createKnowledgeService, knowledgeServiceInternals } from "./knowledge-service.js";
import { logger as defaultLogger } from "./logger.js";

// The Command Center's knowledge route. Since the generic knowledge engine
// was extracted into knowledge-service.js, everything left here is the part
// that is genuinely Command-Center-specific: its own token, its own request
// contract (the only one carrying a `context` field), its own event names
// and its own rate budget. The answering logic itself is no longer duplicated
// or forked - it is the same module the generic /api/v1/knowledge route uses,
// so this path keeps behaving exactly as before by construction rather than
// by two copies being kept in sync.
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;

function setHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
}

function sendJson(response, statusCode, payload) {
  if (response.writableEnded || response.destroyed) return;
  response.statusCode = statusCode;
  response.end(JSON.stringify(payload));
}

// Metadata-only: requestId, route, state, both sub-states, result counts and
// cited source IDs (K1/K2/K3, never sourceDoc), duration, a safe error code
// and answer length. Never the question, a snippet, the full answer, a
// vault path or a provider raw body - safeMetadata is capped and sanitized
// by logger.js itself as a second layer.
function safeLog(eventLogger, event, { requestId, durationMs, safeMetadata = {} } = {}) {
  try {
    const result = eventLogger?.log?.({ event, requestId: requestId || null, durationMs: Number.isFinite(durationMs) ? durationMs : null, safeMetadata });
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Logging is never allowed to break the response.
  }
}

export function createCcKnowledgeHandler({
  env = process.env,
  timingSafeEqualFn,
  now = () => new Date(),
  eventLogger = defaultLogger,
  retrieveKnowledgeFn,
  // Test-only seams: production never overrides these.
  adapterFactory,
  totalTimeoutMs = CC_KNOWLEDGE_ABSOLUTE_TIMEOUT_MS
} = {}) {
  const answerKnowledgeQuestion = createKnowledgeService({
    env,
    now,
    retrieveKnowledgeFn,
    adapterFactory,
    totalTimeoutMs,
    maxConcurrentRequests: CC_KNOWLEDGE_MAX_CONCURRENT_REQUESTS,
    maxRequestsPerWindow: CC_KNOWLEDGE_MAX_REQUESTS_PER_WINDOW,
    requestIdPrefix: "cc-knowledge"
  });

  return async function handleCcKnowledge(request, response) {
    setHeaders(response);
    if (request.headers?.origin) {
      const payload = buildCcKnowledgeTransportFailure({ code: "ORIGIN_NOT_ALLOWED" });
      safeLog(eventLogger, "cc_knowledge_rejected", { safeMetadata: { errorCode: "ORIGIN_NOT_ALLOWED" } });
      return sendJson(response, ccKnowledgeTransportHttpStatus(payload), payload);
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      const payload = buildCcKnowledgeTransportFailure({ code: "METHOD_NOT_ALLOWED" });
      safeLog(eventLogger, "cc_knowledge_rejected", { safeMetadata: { errorCode: "METHOD_NOT_ALLOWED" } });
      return sendJson(response, ccKnowledgeTransportHttpStatus(payload), payload);
    }
    try {
      authenticateInternalRequest(request.headers?.authorization, {
        expectedToken: env.AI_ROUTER_CC_TOKEN,
        timingSafeEqualFn
      });
    } catch (authError) {
      const payload = buildCcKnowledgeTransportFailure(authError);
      safeLog(eventLogger, "cc_knowledge_rejected", { safeMetadata: { errorCode: payload.error.code } });
      return sendJson(response, ccKnowledgeTransportHttpStatus(payload), payload);
    }
    if (!JSON_CONTENT_TYPE.test(String(request.headers?.["content-type"] || ""))) {
      const payload = buildCcKnowledgeTransportFailure(new CcKnowledgeError("VALIDATION_FAILED", "Content-Type must be application/json."));
      safeLog(eventLogger, "cc_knowledge_rejected", { safeMetadata: { errorCode: "VALIDATION_FAILED" } });
      return sendJson(response, ccKnowledgeTransportHttpStatus(payload), payload);
    }

    const startedAt = Date.now();
    let normalized;
    try {
      const raw = await readJsonBody(request, CC_KNOWLEDGE_MAX_REQUEST_BYTES);
      normalized = normalizeCcKnowledgeRequest(raw);
    } catch (requestError) {
      const error = requestError instanceof CcKnowledgeError
        ? requestError
        : new CcKnowledgeError("VALIDATION_FAILED", "The knowledge request is invalid.", {
          safeDetails: { reason: requestError?.code === "PAYLOAD_TOO_LARGE" ? "request_too_large" : "invalid_request" }
        });
      const payload = buildCcKnowledgeTransportFailure(error);
      safeLog(eventLogger, "cc_knowledge_rejected", { safeMetadata: { errorCode: payload.error.code } });
      return sendJson(response, ccKnowledgeTransportHttpStatus(payload), payload);
    }

    const { payload, safeMetadata } = await answerKnowledgeQuestion({
      question: normalized.question,
      context: normalized.context
    });

    safeLog(eventLogger, "cc_knowledge_observed", {
      requestId: null,
      durationMs: Date.now() - startedAt,
      safeMetadata
    });
    return sendJson(response, ccKnowledgeObservationHttpStatus(payload.warnings), payload);
  };
}

export const handleCcKnowledgeRequest = createCcKnowledgeHandler();

// Re-exported unchanged from knowledge-service.js: these helpers moved with
// the engine, but they are still the Command Center path's own behaviour and
// its tests address them here.
export const ccKnowledgeHandlerInternals = knowledgeServiceInternals;
