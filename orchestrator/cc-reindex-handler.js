import { authenticateInternalRequest } from "./internal-auth.js";
import { createConcurrencyLimiter, createRateLimiter } from "./rate-limiter.js";
import { CcReindexError } from "./cc-reindex-error.js";
import { buildCcReindexFailure, buildCcReindexSuccess, ccReindexHttpStatus } from "./cc-reindex-response.js";
import {
  CC_REINDEX_MAX_CONCURRENT_REQUESTS,
  CC_REINDEX_MAX_REQUESTS_PER_WINDOW,
  CC_REINDEX_RATE_WINDOW_MS,
  CC_REINDEX_TIMEOUT_MS
} from "./cc-reindex-config.js";
import { RagError } from "./knowledge/rag-error.js";
import { runRagReindex } from "./knowledge/rag-indexer.js";
import { logger as defaultLogger } from "./logger.js";

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

function safeLog(eventLogger, event, safeMetadata = {}) {
  try {
    const result = eventLogger?.log?.({ event, safeMetadata });
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Logging must never break the reindex response.
  }
}

function withTimeout(operation, timeoutMs, setTimer, clearTimer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      reject(new CcReindexError("REINDEX_FAILED", "The reindex run timed out.", { retryable: true }));
    }, timeoutMs);
    Promise.resolve()
      .then(operation)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        reject(error);
      });
  });
}

// A small closed set of RagError codes that describe a transient condition
// (a provider blip, a lock briefly held by another run, an over-quick
// re-trigger) rather than a structural problem (bad config, bad allowlist,
// corrupt index) - only these are reported as retryable to the caller.
const TRANSIENT_RAG_ERROR_CODES = new Set([
  "EMBEDDING_PROVIDER_UNAVAILABLE",
  "EMBEDDING_TIMEOUT",
  "INDEX_LOCKED"
]);

// Only converts failures from the reindex run itself (a RagError, or a
// CcReindexError already raised by withTimeout on expiry) into the response
// shape. Deliberately narrow: authentication, origin, method and limiter
// errors are NOT routed through this function - they reach
// buildCcReindexFailure directly further down, the same duck-typed-on-.code
// pattern every other cc-* handler in this repo uses (see cc-status-handler.js),
// so a TextResponseError from authenticateInternalRequest keeps its real
// AUTH_REQUIRED/AUTH_INVALID/AUTH_NOT_CONFIGURED code instead of collapsing
// to INTERNAL_ERROR.
function toReindexRunFailure(error) {
  if (error instanceof CcReindexError) return error;
  if (error instanceof RagError) {
    return new CcReindexError("REINDEX_FAILED", "The reindex run failed.", {
      retryable: TRANSIENT_RAG_ERROR_CODES.has(error.code),
      reason: error.code
    });
  }
  return new CcReindexError("INTERNAL_ERROR", "The reindex request could not be completed.");
}

export function createCcReindexHandler({
  env = process.env,
  wallClock = () => new Date(),
  timingSafeEqualFn,
  runRagReindexFn = runRagReindex,
  timeoutMs = CC_REINDEX_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  eventLogger = defaultLogger
} = {}) {
  let protection = null;
  const protectionState = () => {
    if (protection) return protection;
    protection = Object.freeze({
      rateLimiter: createRateLimiter({ maximum: CC_REINDEX_MAX_REQUESTS_PER_WINDOW, windowMs: CC_REINDEX_RATE_WINDOW_MS }),
      concurrencyLimiter: createConcurrencyLimiter({ maximum: CC_REINDEX_MAX_CONCURRENT_REQUESTS })
    });
    return protection;
  };

  return async function handleCcReindex(request, response) {
    const generatedAt = wallClock().toISOString();
    let releaseConcurrency = null;
    try {
      setHeaders(response);

      if (request.headers?.origin) {
        throw new CcReindexError("ORIGIN_NOT_ALLOWED", "Browser-origin requests are not allowed.");
      }

      if (request.method === "OPTIONS") {
        response.setHeader("allow", "POST, OPTIONS");
        response.statusCode = 204;
        response.end();
        return null;
      }

      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        throw new CcReindexError("METHOD_NOT_ALLOWED", "Method is not allowed.");
      }

      const auth = authenticateInternalRequest(request.headers?.authorization, {
        expectedToken: env.AI_ROUTER_CC_TOKEN,
        timingSafeEqualFn
      });

      const state = protectionState();
      const rate = state.rateLimiter.consume(auth.identityFingerprint);
      if (!rate.allowed) {
        response.setHeader("retry-after", String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))));
        throw new CcReindexError("RATE_LIMITED", "The internal request rate limit was exceeded.", { retryable: true });
      }
      releaseConcurrency = state.concurrencyLimiter.tryAcquire();
      if (!releaseConcurrency) {
        throw new CcReindexError("CONCURRENCY_LIMITED", "The concurrent reindex limit was exceeded.", { retryable: true });
      }

      let result;
      try {
        result = await withTimeout(() => runRagReindexFn({ env }), timeoutMs, setTimer, clearTimer);
      } catch (reindexError) {
        throw toReindexRunFailure(reindexError);
      }

      const payload = buildCcReindexSuccess(result, { generatedAt });
      safeLog(eventLogger, "cc_reindex_completed", {
        documentsProcessed: payload.documentsProcessed,
        documentsRejected: payload.documentsRejectedFromAllowlist.length,
        chunkCount: payload.chunkCount,
        forceFullReindex: payload.forceFullReindex
      });
      sendJson(response, 200, payload);
      return payload;
    } catch (caught) {
      const payload = buildCcReindexFailure(caught, { generatedAt });
      safeLog(eventLogger, "cc_reindex_rejected", { errorCode: payload.error.code, reason: payload.error.reason });
      sendJson(response, ccReindexHttpStatus(payload), payload);
      return payload;
    } finally {
      releaseConcurrency?.();
    }
  };
}

export const handleCcReindexRequest = createCcReindexHandler();
