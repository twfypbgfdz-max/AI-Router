import { ROUTER_ALLOWED_ORIGINS, ROUTER_API_DEFAULT_MODE, ROUTER_API_MAX_BODY_BYTES, ROUTER_API_TIMEOUT_MS } from "./config.js";
import { RouterError } from "./contracts.js";
import { safeRequestIdentity } from "./router-contract.js";
import { buildRouterFailure, routerHttpStatus } from "./router-response.js";
import { processRouterRequest, routerStatus } from "./router-service.js";

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;

function setCommonHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
}

function originAllowed(request) {
  const origin = String(request.headers?.origin || "");
  return !origin || ROUTER_ALLOWED_ORIGINS.includes(origin);
}

function applyCors(request, response) {
  const origin = String(request.headers?.origin || "");
  if (!origin || !ROUTER_ALLOWED_ORIGINS.includes(origin)) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "Content-Type");
  response.setHeader("access-control-max-age", "600");
}

function sendJson(response, statusCode, payload) {
  setCommonHeaders(response);
  response.statusCode = statusCode;
  return response.end(JSON.stringify(payload));
}

function failure(code, message, options = {}) {
  return buildRouterFailure(new RouterError(code, message), options);
}

function bodySize(value) {
  try { return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8"); }
  catch { return Number.POSITIVE_INFINITY; }
}

function parseBody(request) {
  const declared = Number(request.headers?.["content-length"] || 0);
  if (Number.isFinite(declared) && declared > ROUTER_API_MAX_BODY_BYTES) throw new RouterError("PAYLOAD_TOO_LARGE", "Request body is too large.");
  const body = request.body;
  if (bodySize(body) > ROUTER_API_MAX_BODY_BYTES) throw new RouterError("PAYLOAD_TOO_LARGE", "Request body is too large.");
  if (body && typeof body === "object" && !Array.isArray(body)) return body;
  if (typeof body !== "string" || !body.trim()) throw new RouterError("INVALID_REQUEST", "Request body must be valid JSON.");
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  } catch { throw new RouterError("INVALID_REQUEST", "Request body must be valid JSON."); }
}

export async function handleVercelRouterStatus(request, response) {
  setCommonHeaders(response);
  if (!originAllowed(request)) return sendJson(response, 403, failure("ORIGIN_NOT_ALLOWED", "Origin is not allowed."));
  applyCors(request, response);
  if (request.method === "OPTIONS") { response.statusCode = 204; return response.end(); }
  if (request.method !== "GET") {
    response.setHeader("allow", "GET, OPTIONS");
    return sendJson(response, 405, failure("INVALID_REQUEST", "Method is not allowed."));
  }
  return sendJson(response, 200, routerStatus());
}

export async function handleVercelRouterRoute(request, response, {
  routerProcessor = processRouterRequest,
  timeoutMs = ROUTER_API_TIMEOUT_MS,
  now = Date.now
} = {}) {
  setCommonHeaders(response);
  if (!originAllowed(request)) return sendJson(response, 403, failure("ORIGIN_NOT_ALLOWED", "Origin is not allowed."));
  applyCors(request, response);
  if (request.method === "OPTIONS") { response.statusCode = 204; return response.end(); }
  if (request.method !== "POST") {
    response.setHeader("allow", "POST, OPTIONS");
    return sendJson(response, 405, failure("INVALID_REQUEST", "Method is not allowed."));
  }
  if (!JSON_CONTENT_TYPE.test(String(request.headers?.["content-type"] || ""))) {
    const payload = failure("INVALID_REQUEST", "Content-Type must be application/json.");
    return sendJson(response, routerHttpStatus(payload.error.code), payload);
  }

  const startedAt = now();
  let input;
  let identity = { requestId: null, mode: ROUTER_API_DEFAULT_MODE };
  try {
    input = parseBody(request);
    identity = safeRequestIdentity(input);
  } catch (error) {
    const payload = buildRouterFailure(error, { ...identity, durationMs: Math.max(0, now() - startedAt) });
    return sendJson(response, routerHttpStatus(payload.error.code), payload);
  }

  let timer;
  try {
    const operation = Promise.resolve(routerProcessor(input, { eventLogger: null })).catch((error) => buildRouterFailure(error, { ...identity, durationMs: Math.max(0, now() - startedAt) }));
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(failure("TIMEOUT", "Router request timed out.", { ...identity, durationMs: Math.max(1, now() - startedAt) })), timeoutMs);
    });
    const payload = await Promise.race([operation, timeout]);
    return sendJson(response, payload.error ? routerHttpStatus(payload.error.code) : 200, payload);
  } finally { clearTimeout(timer); }
}
