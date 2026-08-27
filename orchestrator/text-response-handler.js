import {
  TEXT_RESPONSE_MAX_BODY_BYTES,
  TEXT_RESPONSE_RATE_WINDOW_MS,
  TEXT_RESPONSE_TOTAL_TIMEOUT_MS,
  loadTextResponseProtectionConfig
} from "./text-response-config.js";
import { safeTextResponseIdentity } from "./text-response-contract.js";
import { TextResponseError } from "./text-response-error.js";
import { authenticateInternalRequest } from "./internal-auth.js";
import { createConcurrencyLimiter, createRateLimiter } from "./rate-limiter.js";
import { responseMetadataLogger } from "./response-metadata-logger.js";
import {
  buildTextResponseFailure,
  buildTextResponseSuccess,
  textResponseHttpStatus
} from "./text-response-response.js";
import { createTextResponseService } from "./text-response-service.js";

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
  setHeaders(response);
  response.statusCode = statusCode;
  response.end(JSON.stringify(payload));
}

function bodySize(value) {
  try {
    return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function readStreamBody(request, signal) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
      signal.removeEventListener("abort", onSignalAbort);
    };
    const fail = (error, drain = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain && typeof request.resume === "function") request.resume();
      reject(error);
    };
    const onData = (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > TEXT_RESPONSE_MAX_BODY_BYTES) {
        fail(new TextResponseError("INPUT_TOO_LARGE", "Request body is too large.", {
          safeDetails: { reason: "body_too_large" }
        }), true);
      }
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch {
        reject(new TextResponseError("VALIDATION_FAILED", "Request body must be valid JSON."));
      }
    };
    const onError = () => fail(new TextResponseError("VALIDATION_FAILED", "Request body could not be read."));
    const onAborted = () => fail(new TextResponseError("PROVIDER_UNAVAILABLE", "Client disconnected.", {
      safeDetails: { reason: "client_disconnected" }
    }));
    const onSignalAbort = () => fail(signal.reason instanceof Error
      ? signal.reason
      : new TextResponseError("PROVIDER_TIMEOUT", "Request timed out.", { safeDetails: { reason: "total_timeout" } }), true);

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    signal.addEventListener("abort", onSignalAbort, { once: true });
    if (signal.aborted) onSignalAbort();
  });
}

async function parseBody(request, signal) {
  if (request.body !== undefined) {
    if (bodySize(request.body) > TEXT_RESPONSE_MAX_BODY_BYTES) {
      throw new TextResponseError("INPUT_TOO_LARGE", "Request body is too large.", {
        safeDetails: { reason: "body_too_large" }
      });
    }
    if (request.body && typeof request.body === "object" && !Array.isArray(request.body)) return request.body;
    if (typeof request.body !== "string" || !request.body.trim()) {
      throw new TextResponseError("VALIDATION_FAILED", "Request body must be valid JSON.");
    }
    try {
      return JSON.parse(request.body);
    } catch {
      throw new TextResponseError("VALIDATION_FAILED", "Request body must be valid JSON.");
    }
  }
  return readStreamBody(request, signal);
}

function attachAbortChain(request, response, serverSignal, setTimer, totalTimeoutMs) {
  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onRequestAborted = () => abort(new TextResponseError("PROVIDER_UNAVAILABLE", "Client disconnected.", {
    safeDetails: { reason: "client_disconnected" }
  }));
  const onSocketClose = () => {
    if (!response.writableEnded) onRequestAborted();
  };
  const onServerAbort = () => abort(serverSignal?.reason instanceof TextResponseError
    ? serverSignal.reason
    : new TextResponseError("PROVIDER_UNAVAILABLE", "Server aborted the request.", {
      safeDetails: { reason: "server_aborted" }
    }));
  request.once?.("aborted", onRequestAborted);
  request.socket?.once?.("close", onSocketClose);
  serverSignal?.addEventListener?.("abort", onServerAbort, { once: true });
  const timer = setTimer(() => abort(new TextResponseError("PROVIDER_TIMEOUT", "Request timed out.", {
    safeDetails: { reason: "total_timeout" }
  })), totalTimeoutMs);
  return Object.freeze({
    signal: controller.signal,
    cleanup(clearTimer) {
      clearTimer(timer);
      request.off?.("aborted", onRequestAborted);
      request.socket?.off?.("close", onSocketClose);
      serverSignal?.removeEventListener?.("abort", onServerAbort);
    }
  });
}

function declaredBodyTooLarge(request) {
  const declared = Number(request.headers?.["content-length"] || 0);
  return Number.isFinite(declared) && declared > TEXT_RESPONSE_MAX_BODY_BYTES;
}

export function createTextResponseHandler({
  env = process.env,
  adapterFactory,
  metadataLogger = responseMetadataLogger,
  now = Date.now,
  wallClock = () => new Date(),
  rateNow = Date.now,
  timingSafeEqualFn,
  serverSignal = null,
  totalTimeoutMs = TEXT_RESPONSE_TOTAL_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  // When set, overrides whatever intent the caller sent, server-side, before
  // validation. Used by the dedicated structured-report endpoints so the
  // client cannot pick a different report shape.
  forcedIntent = null,
  // Overrides the rate-limiter's window length. Every existing caller omits
  // this and keeps the fixed 60s window (TEXT_RESPONSE_RATE_WINDOW_MS) - only
  // knowledge-service.js's Jarvis-specific instance passes a shorter one (see
  // JARVIS_ASK_RATE_WINDOW_MS in knowledge-config.js). maxRequestsPerMinute
  // still governs how many requests fit in that window.
  rateWindowMs = TEXT_RESPONSE_RATE_WINDOW_MS
} = {}) {
  let protection = null;
  const protectionState = () => {
    if (protection) return protection;
    const config = loadTextResponseProtectionConfig(env);
    protection = Object.freeze({
      rateLimiter: createRateLimiter({
        maximum: config.maxRequestsPerMinute,
        windowMs: rateWindowMs,
        now: rateNow
      }),
      concurrencyLimiter: createConcurrencyLimiter({ maximum: config.maxConcurrentRequests })
    });
    return protection;
  };

  return async function handleTextResponse(request, response, { executionRequestText, allowedCitedSourceIds } = {}) {
    const startedAt = now();
    let identity = { requestId: null, source: null };
    let serviceResult = null;
    let error = null;
    let releaseConcurrency = null;
    let abortChain = null;
    let rateLimitDecision = "not_checked";
    try {
      setHeaders(response);
      if (request.headers?.origin) {
        throw new TextResponseError("SECURITY_BLOCKED", "Browser-origin requests are not allowed.", {
          safeDetails: { reason: "browser_origin_blocked" }
        });
      }
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        throw new TextResponseError("VALIDATION_FAILED", "Method is not allowed.");
      }
      if (!JSON_CONTENT_TYPE.test(String(request.headers?.["content-type"] || ""))) {
        throw new TextResponseError("VALIDATION_FAILED", "Content-Type must be application/json.");
      }
      if (declaredBodyTooLarge(request)) {
        throw new TextResponseError("INPUT_TOO_LARGE", "Request body is too large.", {
          safeDetails: { reason: "body_too_large" }
        });
      }

      const auth = authenticateInternalRequest(request.headers?.authorization, {
        expectedToken: env.AI_ROUTER_INTERNAL_TOKEN,
        timingSafeEqualFn
      });
      const state = protectionState();
      const rate = state.rateLimiter.consume(auth.identityFingerprint);
      rateLimitDecision = rate.allowed ? "allowed" : "rejected";
      if (!rate.allowed) {
        response.setHeader("retry-after", String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))));
        throw new TextResponseError("RATE_LIMITED", "Rate limit exceeded.");
      }
      releaseConcurrency = state.concurrencyLimiter.tryAcquire();
      if (!releaseConcurrency) {
        throw new TextResponseError("CONCURRENCY_LIMITED", "Concurrency limit exceeded.");
      }

      abortChain = attachAbortChain(request, response, serverSignal, setTimer, totalTimeoutMs);
      const rawInput = await parseBody(request, abortChain.signal);
      if (forcedIntent && rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
        rawInput.intent = forcedIntent;
      }
      identity = safeTextResponseIdentity(rawInput);
      const service = createTextResponseService({
        env,
        adapterFactory,
        now: wallClock,
        setTimer,
        clearTimer
      });
      serviceResult = await service.respond(rawInput, {
        signal: abortChain.signal,
        executionRequestText,
        allowedCitedSourceIds
      });
      const payload = buildTextResponseSuccess(serviceResult, {
        durationMs: Math.max(0, now() - startedAt)
      });
      sendJson(response, 200, payload);
      return payload;
    } catch (caught) {
      error = caught;
      const payload = buildTextResponseFailure(caught, {
        requestId: identity.requestId,
        durationMs: Math.max(0, now() - startedAt)
      });
      sendJson(response, textResponseHttpStatus(payload), payload);
      return payload;
    } finally {
      abortChain?.cleanup(clearTimer);
      releaseConcurrency?.();
      metadataLogger?.logOutcome?.({
        requestId: serviceResult?.request.requestId || identity.requestId,
        source: serviceResult?.request.source || identity.source,
        route: serviceResult?.route.name || null,
        taskType: serviceResult?.route.taskType || null,
        providerId: serviceResult ? serviceResult.provider.providerId : null,
        modelAlias: serviceResult?.provider.modelAlias || null,
        durationMs: Math.max(0, now() - startedAt),
        status: serviceResult ? "answered" : "failed",
        errorCode: serviceResult ? null : error?.code || "INTERNAL_ERROR",
        inputTokenEstimate: serviceResult?.inputTokenEstimate ?? null,
        providerInputTokens: serviceResult?.usage.inputTokens ?? null,
        providerOutputTokens: serviceResult?.usage.outputTokens ?? null,
        calculatedCostUsd: serviceResult?.calculatedCostUsd ?? null,
        abortReason: error?.safeDetails?.reason || null,
        rateLimitDecision
      });
    }
  };
}

export const handleTextResponseRequest = createTextResponseHandler();
export const handleProjectStatusRequest = createTextResponseHandler({ forcedIntent: "project_status_report" });
export const handleGitChangeRequest = createTextResponseHandler({ forcedIntent: "git_change_report" });

export const textResponseHandlerInternals = Object.freeze({
  bodySize,
  parseBody,
  declaredBodyTooLarge
});
