import crypto from "node:crypto";
import { readJsonBody } from "./http-utils.js";
import { authenticateInternalRequest } from "./internal-auth.js";
import { CcSnapshotError } from "./cc-snapshot-error.js";
import { normalizeCcSnapshotRequest } from "./cc-snapshot-contract.js";
import { rankSnapshot } from "./cc-snapshot-ranking.js";
import { buildCcSnapshotPromptText } from "./cc-snapshot-prompt.js";
import { retrieveKnowledge } from "./knowledge-answer-rag-service.js";
import {
  buildCcSnapshotResult,
  buildCcSnapshotTransportFailure,
  ccSnapshotTransportHttpStatus
} from "./cc-snapshot-response.js";
import {
  CC_SNAPSHOT_ABSOLUTE_TIMEOUT_MS,
  CC_SNAPSHOT_MAX_CONCURRENT_REQUESTS,
  CC_SNAPSHOT_MAX_NARRATIVE_BYTES,
  CC_SNAPSHOT_MAX_REQUEST_BYTES,
  CC_SNAPSHOT_MAX_REQUESTS_PER_WINDOW,
  CC_SNAPSHOT_MAX_RETRY_AFTER_SECONDS
} from "./cc-snapshot-config.js";
import { loadOllamaTextProviderConfig } from "./text-response-config.js";
import { checkOllamaModelAvailable } from "./ollama-availability.js";
import { createTextResponseHandler } from "./text-response-handler.js";
import { logger as defaultLogger } from "./logger.js";

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

function safeLog(eventLogger, event, safeMetadata = {}) {
  try {
    const result = eventLogger?.log?.({ event, safeMetadata });
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Logging is never allowed to break the response.
  }
}

function buildInternalRequestId() {
  return `cc-snapshot-${crypto.randomUUID()}`;
}

// A plain internal request object, never a browser fetch - identical pattern
// to cc-summary-handler.js/cc-knowledge-handler.js's buildInternalRequest.
// Only the already-computed ranking (via buildCcSnapshotPromptText) is ever
// sent as input.content - never the raw sections.
function buildInternalRequest(promptText, internalToken) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(internalToken ? { authorization: `Bearer ${internalToken}` } : {})
    },
    body: {
      schemaVersion: "1.0",
      requestId: buildInternalRequestId(),
      source: "internal_test",
      intent: "snapshot_briefing",
      input: { type: "text", content: promptText }
    }
  };
}

function captureResponse() {
  const headers = new Map();
  return {
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    body: "",
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(chunk = "") {
      this.body = chunk;
      this.writableEnded = true;
    }
  };
}

function mapProviderErrorToState(code) {
  if (code === "PROVIDER_TIMEOUT") return "timeout";
  if (code === "PROVIDER_UNAVAILABLE" || code === "PROVIDER_NOT_CONFIGURED") return "not_connected";
  return "invalid_response";
}

// Same bounded-and-verified pattern as cc-summary-handler.js's
// safeRetryAfterSeconds: only a value that actually came from the shared
// rate limiter's own Retry-After header is ever surfaced, never guessed.
function safeRetryAfterSeconds(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > CC_SNAPSHOT_MAX_RETRY_AFTER_SECONDS) return null;
  return parsed;
}

function mapGenerationFailure(generationPayload, internalResponse) {
  const code = generationPayload.error?.code;
  if (code === "RATE_LIMITED") {
    return { state: "temporarily_unavailable", retryAfterSeconds: safeRetryAfterSeconds(internalResponse.getHeader("retry-after")) };
  }
  if (code === "CONCURRENCY_LIMITED") {
    return { state: "temporarily_unavailable", retryAfterSeconds: null };
  }
  return { state: mapProviderErrorToState(code), retryAfterSeconds: null };
}

function emptyNarrative(state, retryAfterSeconds = null) {
  return { state, text: null, recommendedItemId: null, retryAfterSeconds };
}

export function createCcSnapshotHandler({
  env = process.env,
  timingSafeEqualFn,
  now = () => new Date(),
  checkAvailability = checkOllamaModelAvailable,
  retrieveKnowledgeFn = retrieveKnowledge,
  eventLogger = defaultLogger,
  // Test-only seams: production never overrides these.
  adapterFactory,
  totalTimeoutMs = CC_SNAPSHOT_ABSOLUTE_TIMEOUT_MS
} = {}) {
  // Forces Ollama regardless of the shared AI_ROUTER_TEXT_PROVIDER switch,
  // and scopes this endpoint's concurrency/rate limits independently of
  // every other endpoint - same existing, already-tested env-driven knobs
  // cc-summary/cc-knowledge already use. No new limiter, no second Ollama
  // client, no core file touched.
  const scopedEnv = Object.freeze({
    ...env,
    AI_ROUTER_TEXT_PROVIDER: "ollama",
    AI_ROUTER_MAX_CONCURRENT_REQUESTS: String(CC_SNAPSHOT_MAX_CONCURRENT_REQUESTS),
    AI_ROUTER_MAX_REQUESTS_PER_MINUTE: String(CC_SNAPSHOT_MAX_REQUESTS_PER_WINDOW)
  });
  const textResponseHandler = createTextResponseHandler({
    env: scopedEnv,
    adapterFactory,
    forcedIntent: "snapshot_briefing",
    totalTimeoutMs
  });

  return async function handleCcSnapshot(request, response) {
    setHeaders(response);
    if (request.headers?.origin) {
      const payload = buildCcSnapshotTransportFailure({ code: "ORIGIN_NOT_ALLOWED" });
      safeLog(eventLogger, "cc_snapshot_rejected", { errorCode: "ORIGIN_NOT_ALLOWED" });
      return sendJson(response, ccSnapshotTransportHttpStatus(payload), payload);
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      const payload = buildCcSnapshotTransportFailure({ code: "METHOD_NOT_ALLOWED" });
      safeLog(eventLogger, "cc_snapshot_rejected", { errorCode: "METHOD_NOT_ALLOWED" });
      return sendJson(response, ccSnapshotTransportHttpStatus(payload), payload);
    }
    try {
      authenticateInternalRequest(request.headers?.authorization, {
        expectedToken: env.AI_ROUTER_CC_TOKEN,
        timingSafeEqualFn
      });
    } catch (authError) {
      const payload = buildCcSnapshotTransportFailure(authError);
      safeLog(eventLogger, "cc_snapshot_rejected", { errorCode: payload.error.code });
      return sendJson(response, ccSnapshotTransportHttpStatus(payload), payload);
    }
    if (!JSON_CONTENT_TYPE.test(String(request.headers?.["content-type"] || ""))) {
      const payload = buildCcSnapshotTransportFailure(new CcSnapshotError("VALIDATION_FAILED", "Content-Type must be application/json."));
      safeLog(eventLogger, "cc_snapshot_rejected", { errorCode: "VALIDATION_FAILED" });
      return sendJson(response, ccSnapshotTransportHttpStatus(payload), payload);
    }

    const startedAt = Date.now();
    let normalized;
    try {
      const raw = await readJsonBody(request, CC_SNAPSHOT_MAX_REQUEST_BYTES);
      normalized = normalizeCcSnapshotRequest(raw, { now });
    } catch (requestError) {
      const error = requestError instanceof CcSnapshotError
        ? requestError
        : new CcSnapshotError("VALIDATION_FAILED", "The snapshot request is invalid.", {
          safeDetails: { reason: requestError?.code === "PAYLOAD_TOO_LARGE" ? "request_too_large" : "invalid_request" }
        });
      const payload = buildCcSnapshotTransportFailure(error);
      safeLog(eventLogger, "cc_snapshot_rejected", { errorCode: payload.error.code });
      return sendJson(response, ccSnapshotTransportHttpStatus(payload), payload);
    }

    // Ranking is pure computation over already-validated input - it never
    // fails and never depends on Ollama, the network, or the filesystem.
    // No snapshot content is persisted anywhere; everything below lives only
    // for the duration of this request.
    const ranking = rankSnapshot(normalized);
    const topItemId = ranking.items.length ? ranking.items[0].itemId : null;

    function finish(narrative, knowledgeHits, extraMeta = {}) {
      const payload = buildCcSnapshotResult({ ranking, narrative, knowledgeHits, now });
      safeLog(eventLogger, "cc_snapshot_observed", {
        narrativeState: narrative.state,
        rankedCount: ranking.items.length,
        unrankedCount: ranking.unranked.length,
        knowledgeHitCount: payload.knowledgeHits.length,
        durationMs: Date.now() - startedAt,
        ...extraMeta
      });
      return sendJson(response, 200, payload);
    }

    const knowledgeHitsPromise = normalized.knowledgeQuery
      ? retrieveKnowledgeFn(normalized.knowledgeQuery, { env: scopedEnv }).then((r) => r.results).catch(() => [])
      : Promise.resolve([]);

    let ollamaConfig;
    try {
      ollamaConfig = loadOllamaTextProviderConfig(scopedEnv);
    } catch {
      return finish(emptyNarrative("not_connected"), await knowledgeHitsPromise);
    }

    let modelAvailable;
    try {
      modelAvailable = await checkAvailability({ baseUrl: ollamaConfig.baseUrl, model: ollamaConfig.model });
    } catch (availabilityError) {
      return finish(emptyNarrative(mapProviderErrorToState(availabilityError?.code)), await knowledgeHitsPromise);
    }
    if (!modelAvailable) {
      return finish(emptyNarrative("model_missing"), await knowledgeHitsPromise);
    }

    const promptText = buildCcSnapshotPromptText(ranking);
    const internalRequest = buildInternalRequest(promptText, scopedEnv.AI_ROUTER_INTERNAL_TOKEN);
    const internalResponse = captureResponse();
    const generationPayload = await textResponseHandler(internalRequest, internalResponse);

    if (generationPayload.status !== "answered") {
      const { state, retryAfterSeconds } = mapGenerationFailure(generationPayload, internalResponse);
      return finish(emptyNarrative(state, retryAfterSeconds), await knowledgeHitsPromise, { errorCode: generationPayload.error?.code || null });
    }

    // The shared service already ran parseStructuredReport("snapshot_briefing", ...)
    // fail-closed before reaching "answered" - structured is always a valid
    // {text, recommendedItemId: <ID-shaped string>|null} object here, but
    // that only checked shape, not membership in this request's ranking.
    const { text: narrativeText, recommendedItemId: modelRecommendedItemId } = generationPayload.answer.structured;

    // The model's stated ID is a consistency check only, never the source
    // of truth: recommendedItemId in the response is always the router's
    // own deterministic top item (or null), never taken from the model's
    // output. Router decides; Ollama only confirms and explains (Abschnitt 6
    // des genehmigten Vertrags). A mismatch - including any ID that is not
    // an entry in ranking.items at all - fails closed as invalid_response.
    if (modelRecommendedItemId !== topItemId) {
      return finish(emptyNarrative("invalid_response"), await knowledgeHitsPromise, { errorCode: "recommendation_not_in_ranking" });
    }

    if (Buffer.byteLength(narrativeText, "utf8") > CC_SNAPSHOT_MAX_NARRATIVE_BYTES) {
      return finish(emptyNarrative("invalid_response"), await knowledgeHitsPromise, { errorCode: "narrative_too_large" });
    }

    return finish(
      { state: "ok", text: narrativeText, recommendedItemId: topItemId, retryAfterSeconds: null },
      await knowledgeHitsPromise
    );
  };
}

export const handleCcSnapshotRequest = createCcSnapshotHandler();

export const ccSnapshotHandlerInternals = Object.freeze({ mapGenerationFailure, mapProviderErrorToState, safeRetryAfterSeconds });
