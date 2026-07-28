import crypto from "node:crypto";
import { readJsonBody } from "./http-utils.js";
import { authenticateInternalRequest } from "./internal-auth.js";
import { CcSummaryError } from "./cc-summary-error.js";
import { normalizeCcSummaryRequest } from "./cc-summary-contract.js";
import { buildCcSummaryPromptText } from "./cc-summary-prompt.js";
import {
  buildCcSummaryObservation,
  buildCcSummaryTransportFailure,
  ccSummaryObservationHttpStatus,
  ccSummaryTransportHttpStatus
} from "./cc-summary-response.js";
import {
  CC_SUMMARY_ABSOLUTE_TIMEOUT_MS,
  CC_SUMMARY_MAX_CONCURRENT_REQUESTS,
  CC_SUMMARY_MAX_REQUEST_BYTES,
  CC_SUMMARY_MAX_REQUESTS_PER_WINDOW,
  CC_SUMMARY_MAX_RETRY_AFTER_SECONDS,
  CC_SUMMARY_MAX_VISIBLE_SUMMARY_BYTES
} from "./cc-summary-config.js";
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
  return `cc-summary-${crypto.randomUUID()}`;
}

// A plain internal request object, never a browser fetch: no Origin header,
// the internal Bearer token attached here from server config (never seen by
// the Command-Center caller), body set directly so the shared handler skips
// stream parsing. Exactly the same pattern already used by the router
// console's own proxy - one established way to reach the shared pipeline
// in-process, not a second implementation of it.
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
      intent: "auto",
      input: { type: "text", content: promptText }
    }
  };
}

// Captures headers the shared handler sets (notably Retry-After on
// RATE_LIMITED) instead of discarding them, so a real limiter-issued value
// can be read back after the call - never invented or estimated here.
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

// Only a value that actually came from the shared rate limiter's own
// Retry-After header is ever surfaced, strictly validated and bounded by
// the limiter's fixed window - anything else (missing, non-numeric, zero,
// out of range) is dropped rather than guessed.
function safeRetryAfterSeconds(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > CC_SUMMARY_MAX_RETRY_AFTER_SECONDS) return null;
  return parsed;
}

// RATE_LIMITED and CONCURRENCY_LIMITED are the only two shared-pipeline
// codes that mean "temporary capacity, try again" rather than an actual
// connectivity, model, timeout or validity problem - they get their own
// closed state instead of being folded into invalid_response. This never
// introduces a new /api/router/respond error code: the shared pipeline's
// existing RATE_LIMITED/CONCURRENCY_LIMITED codes are read here, not added.
function mapGenerationFailure(generationPayload, internalResponse) {
  const code = generationPayload.error?.code;
  if (code === "RATE_LIMITED") {
    return { state: "temporarily_unavailable", retryAfterSeconds: safeRetryAfterSeconds(internalResponse.getHeader("retry-after")) };
  }
  if (code === "CONCURRENCY_LIMITED") {
    // No Retry-After is ever set by the shared handler for this code - never
    // estimate one.
    return { state: "temporarily_unavailable", retryAfterSeconds: null };
  }
  return { state: mapProviderErrorToState(code), retryAfterSeconds: null };
}

function mapRequestErrorToReason(error) {
  if (error instanceof CcSummaryError) {
    return error.code === "SECURITY_BLOCKED" ? "security_blocked" : "validation_failed";
  }
  if (error?.code === "PAYLOAD_TOO_LARGE") return "request_too_large";
  return "invalid_request";
}

export function createCcSummaryHandler({
  env = process.env,
  timingSafeEqualFn,
  now = () => new Date(),
  checkAvailability = checkOllamaModelAvailable,
  eventLogger = defaultLogger,
  // Test-only seams: production never overrides these. adapterFactory
  // overrides which adapter the shared pipeline calls (the scoped env below
  // is what forces Ollama, not this); totalTimeoutMs lets tests use a short
  // bound instead of the real 30s ceiling.
  adapterFactory,
  totalTimeoutMs = CC_SUMMARY_ABSOLUTE_TIMEOUT_MS
} = {}) {
  // Forces Ollama regardless of the shared AI_ROUTER_TEXT_PROVIDER switch,
  // and scopes this endpoint's concurrency/rate limits independently of
  // /api/router/respond - both via existing, already-tested env-driven
  // knobs. No new limiter, no second Ollama client, no core file touched.
  const scopedEnv = Object.freeze({
    ...env,
    AI_ROUTER_TEXT_PROVIDER: "ollama",
    AI_ROUTER_MAX_CONCURRENT_REQUESTS: String(CC_SUMMARY_MAX_CONCURRENT_REQUESTS),
    AI_ROUTER_MAX_REQUESTS_PER_MINUTE: String(CC_SUMMARY_MAX_REQUESTS_PER_WINDOW)
  });
  const textResponseHandler = createTextResponseHandler({
    env: scopedEnv,
    adapterFactory,
    forcedIntent: "project_status_summary",
    totalTimeoutMs
  });

  return async function handleCcSummary(request, response) {
    setHeaders(response);
    if (request.headers?.origin) {
      const payload = buildCcSummaryTransportFailure({ code: "ORIGIN_NOT_ALLOWED" });
      safeLog(eventLogger, "cc_summary_rejected", { errorCode: "ORIGIN_NOT_ALLOWED" });
      return sendJson(response, ccSummaryTransportHttpStatus(payload), payload);
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      const payload = buildCcSummaryTransportFailure({ code: "METHOD_NOT_ALLOWED" });
      safeLog(eventLogger, "cc_summary_rejected", { errorCode: "METHOD_NOT_ALLOWED" });
      return sendJson(response, ccSummaryTransportHttpStatus(payload), payload);
    }
    try {
      authenticateInternalRequest(request.headers?.authorization, {
        expectedToken: env.AI_ROUTER_CC_TOKEN,
        timingSafeEqualFn
      });
    } catch (authError) {
      const payload = buildCcSummaryTransportFailure(authError);
      safeLog(eventLogger, "cc_summary_rejected", { errorCode: payload.error.code });
      return sendJson(response, ccSummaryTransportHttpStatus(payload), payload);
    }
    if (!JSON_CONTENT_TYPE.test(String(request.headers?.["content-type"] || ""))) {
      const payload = buildCcSummaryObservation({ state: "input_rejected", reason: "invalid_content_type", now });
      safeLog(eventLogger, "cc_summary_rejected", { errorCode: "input_rejected" });
      return sendJson(response, ccSummaryObservationHttpStatus(payload.state), payload);
    }

    const startedAt = Date.now();
    let normalized;
    try {
      const raw = await readJsonBody(request, CC_SUMMARY_MAX_REQUEST_BYTES);
      normalized = normalizeCcSummaryRequest(raw);
    } catch (requestError) {
      const payload = buildCcSummaryObservation({
        state: "input_rejected",
        reason: mapRequestErrorToReason(requestError),
        now
      });
      safeLog(eventLogger, "cc_summary_rejected", { errorCode: "input_rejected" });
      return sendJson(response, ccSummaryObservationHttpStatus(payload.state), payload);
    }

    let ollamaConfig;
    try {
      ollamaConfig = loadOllamaTextProviderConfig(scopedEnv);
    } catch {
      const payload = buildCcSummaryObservation({ state: "not_connected", now });
      safeLog(eventLogger, "cc_summary_observed", { state: "not_connected", durationMs: Date.now() - startedAt });
      return sendJson(response, ccSummaryObservationHttpStatus(payload.state), payload);
    }

    let modelAvailable;
    try {
      modelAvailable = await checkAvailability({ baseUrl: ollamaConfig.baseUrl, model: ollamaConfig.model });
    } catch (availabilityError) {
      const state = mapProviderErrorToState(availabilityError?.code);
      const payload = buildCcSummaryObservation({ state, now });
      safeLog(eventLogger, "cc_summary_observed", { state, durationMs: Date.now() - startedAt });
      return sendJson(response, ccSummaryObservationHttpStatus(payload.state), payload);
    }
    if (!modelAvailable) {
      const payload = buildCcSummaryObservation({ state: "model_missing", now });
      safeLog(eventLogger, "cc_summary_observed", { state: "model_missing", durationMs: Date.now() - startedAt });
      return sendJson(response, ccSummaryObservationHttpStatus(payload.state), payload);
    }

    const promptText = buildCcSummaryPromptText(normalized.context);
    const internalRequest = buildInternalRequest(promptText, scopedEnv.AI_ROUTER_INTERNAL_TOKEN);
    const internalResponse = captureResponse();
    const generationPayload = await textResponseHandler(internalRequest, internalResponse);

    if (generationPayload.status !== "answered") {
      const { state, retryAfterSeconds } = mapGenerationFailure(generationPayload, internalResponse);
      if (retryAfterSeconds !== null) response.setHeader("retry-after", String(retryAfterSeconds));
      const payload = buildCcSummaryObservation({ state, retryAfterSeconds, now });
      safeLog(eventLogger, "cc_summary_observed", { state, durationMs: Date.now() - startedAt });
      return sendJson(response, ccSummaryObservationHttpStatus(payload.state), payload);
    }

    // The shared pipeline already rejects an empty answer as
    // PROVIDER_RESPONSE_INVALID before reaching "answered", so summaryText
    // is never empty here - only the endpoint's own tighter visible-summary
    // cap (4 KiB, stricter than the shared pipeline's default) is checked.
    const summaryText = generationPayload.answer.text;
    if (Buffer.byteLength(summaryText, "utf8") > CC_SUMMARY_MAX_VISIBLE_SUMMARY_BYTES) {
      const payload = buildCcSummaryObservation({ state: "response_too_large", now });
      safeLog(eventLogger, "cc_summary_observed", { state: "response_too_large", durationMs: Date.now() - startedAt });
      return sendJson(response, ccSummaryObservationHttpStatus(payload.state), payload);
    }

    const payload = buildCcSummaryObservation({
      state: "ok",
      summary: summaryText,
      provider: "ollama",
      model: ollamaConfig.model,
      now
    });
    safeLog(eventLogger, "cc_summary_observed", { state: "ok", durationMs: Date.now() - startedAt });
    return sendJson(response, ccSummaryObservationHttpStatus(payload.state), payload);
  };
}

export const handleCcSummaryRequest = createCcSummaryHandler();

// Exposed for targeted unit testing only. With CC_SUMMARY_MAX_REQUESTS_PER_WINDOW
// and CC_SUMMARY_MAX_CONCURRENT_REQUESTS both at 1 and a single shared internal
// identity, the shared pipeline's rate check always runs before its
// concurrency check - so CONCURRENCY_LIMITED cannot currently be forced
// end-to-end through real HTTP calls. Its mapping is verified directly here.
export const ccSummaryHandlerInternals = Object.freeze({ mapGenerationFailure, safeRetryAfterSeconds });
