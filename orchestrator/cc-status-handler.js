import { CC_STATUS_TIMEOUT_MS } from "./cc-status-config.js";
import { CcStatusError } from "./cc-status-error.js";
import { authenticateInternalRequest } from "./internal-auth.js";
import { buildCcStatusData } from "./cc-status-service.js";
import { buildCcStatusFailure, buildCcStatusSuccess, ccStatusHttpStatus } from "./cc-status-response.js";
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
    // Logging must never break the status response.
  }
}

function withTimeout(operation, timeoutMs, setTimer, clearTimer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      reject(new CcStatusError("UPSTREAM_UNAVAILABLE", "Router status data is temporarily unavailable.", { retryable: true }));
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

export function createCcStatusHandler({
  env = process.env,
  wallClock = () => new Date(),
  timingSafeEqualFn,
  registry,
  buildStatusData = () => buildCcStatusData(registry ? { registry } : {}),
  timeoutMs = CC_STATUS_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  eventLogger = defaultLogger
} = {}) {
  return async function handleCcStatus(request, response) {
    const generatedAt = wallClock().toISOString();
    try {
      setHeaders(response);

      if (request.headers?.origin) {
        throw new CcStatusError("ORIGIN_NOT_ALLOWED", "Browser-origin requests are not allowed.");
      }

      if (request.method === "OPTIONS") {
        response.setHeader("allow", "GET, OPTIONS");
        response.statusCode = 204;
        response.end();
        return null;
      }

      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        throw new CcStatusError("METHOD_NOT_ALLOWED", "Method is not allowed.");
      }

      authenticateInternalRequest(request.headers?.authorization, {
        expectedToken: env.AI_ROUTER_CC_TOKEN,
        timingSafeEqualFn
      });

      let data;
      try {
        data = await withTimeout(buildStatusData, timeoutMs, setTimer, clearTimer);
      } catch (aggregationError) {
        if (aggregationError instanceof CcStatusError) throw aggregationError;
        throw new CcStatusError("UPSTREAM_UNAVAILABLE", "Router status data is temporarily unavailable.", { retryable: true });
      }
      const payload = buildCcStatusSuccess(data, { generatedAt });
      safeLog(eventLogger, "cc_status_checked", { routerStatus: data.routerStatus, providerCount: data.providers.length });
      sendJson(response, 200, payload);
      return payload;
    } catch (caught) {
      const payload = buildCcStatusFailure(caught, { generatedAt });
      safeLog(eventLogger, "cc_status_rejected", { errorCode: payload.error.code });
      sendJson(response, ccStatusHttpStatus(payload), payload);
      return payload;
    }
  };
}

export const handleCcStatusRequest = createCcStatusHandler();
