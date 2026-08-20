import { readJsonBody } from "./http-utils.js";
import { authenticateInternalRequest } from "./internal-auth.js";
import { KnowledgeError } from "./knowledge-error.js";
import { normalizeKnowledgeRequest } from "./knowledge-contract.js";
import {
  buildKnowledgeAnswerTransportFailure,
  knowledgeAnswerObservationHttpStatus,
  knowledgeAnswerTransportHttpStatus
} from "./knowledge-answer-response.js";
import {
  KNOWLEDGE_ABSOLUTE_TIMEOUT_MS,
  KNOWLEDGE_MAX_CONCURRENT_REQUESTS,
  KNOWLEDGE_MAX_REQUEST_BYTES,
  KNOWLEDGE_MAX_REQUESTS_PER_WINDOW,
  KNOWLEDGE_SCHEMA_VERSION,
  KNOWLEDGE_TOKEN_ENV_VAR
} from "./knowledge-config.js";
import { createKnowledgeService } from "./knowledge-service.js";
import { logger as defaultLogger } from "./logger.js";

// The generic, read-only knowledge route: POST /api/v1/knowledge.
//
// Same answering engine as the Command Center route (knowledge-service.js),
// but its own token, its own contract and its own rate budget. It exists so
// a second consumer never has to borrow the Command Center's identity: the
// cc/knowledge contract stays exactly what it always was, untouched and
// unmigrated.
//
// Read-only in the strongest sense available here: this route can retrieve
// and answer, and it can do nothing else. It cannot re-index, cannot write
// to the vault, cannot reach a cloud provider (the service pins Ollama) and
// cannot trigger an action. Holding this route's token grants strictly less
// than holding AI_ROUTER_CC_TOKEN.
//
// Browser requests are refused outright, exactly as on the CC route: a page
// must go through a server-side proxy that attaches the token from the
// server's own environment, so a token never reaches a browser.
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

// Metadata-only, identical policy to the CC route: states, counts, whether
// sources were cited, duration, a safe error code and answer length. Never
// the question, never a snippet, never the answer text, never a vault path.
function safeLog(eventLogger, event, { durationMs, safeMetadata = {} } = {}) {
  try {
    const result = eventLogger?.log?.({ event, requestId: null, durationMs: Number.isFinite(durationMs) ? durationMs : null, safeMetadata });
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Logging is never allowed to break the response.
  }
}

const transportFailure = (error) => buildKnowledgeAnswerTransportFailure(error, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });

// Default seam: no operational (Cockpit day) context, ever. The production
// /api/v1/knowledge singleton exported below never overrides this, so its
// behaviour is byte-for-byte what it always was. Only jarvis-console-proxy.js
// builds its own createKnowledgeHandler({ operationalContextProviderFn })
// instance with a real provider - this generic route stays a pure knowledge
// consumer, exactly as its own contract (knowledge-contract.js) says.
async function noOperationalContext() {
  return null;
}

// Same shape and same reason as noOperationalContext above: the production
// /api/v1/knowledge singleton never overrides this, so its behaviour is
// byte-for-byte what it always was. Only jarvis-console-proxy.js supplies a
// real sessionContextProviderFn, built from orchestrator/session/ - this
// generic route never learns about sessions at all.
async function noSessionContext() {
  return null;
}

export function createKnowledgeHandler({
  env = process.env,
  timingSafeEqualFn,
  now = () => new Date(),
  eventLogger = defaultLogger,
  retrieveKnowledgeFn,
  // Test-only seams: production never overrides these.
  adapterFactory,
  totalTimeoutMs = KNOWLEDGE_ABSOLUTE_TIMEOUT_MS,
  // Constructor-time fallback only - production never overrides this (see
  // the call-time parameter of the same name on the returned handler
  // below, which is how jarvis-console-proxy.js actually supplies one).
  // Kept as a constructor option purely so a test can build a fully
  // self-contained handler instance without needing to thread the option
  // through every call site.
  operationalContextProviderFn: defaultOperationalContextProviderFn = noOperationalContext,
  // Constructor-time fallback only, mirroring operationalContextProviderFn
  // above - production never overrides this either.
  sessionContextProviderFn: defaultSessionContextProviderFn = noSessionContext
} = {}) {
  const answerKnowledgeQuestion = createKnowledgeService({
    env,
    now,
    retrieveKnowledgeFn,
    adapterFactory,
    totalTimeoutMs,
    maxConcurrentRequests: KNOWLEDGE_MAX_CONCURRENT_REQUESTS,
    maxRequestsPerWindow: KNOWLEDGE_MAX_REQUESTS_PER_WINDOW,
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    requestIdPrefix: "knowledge"
  });

  // operationalContextProviderFn is a per-call option, not baked into the
  // handler at construction: this is what lets jarvis-console-proxy.js
  // reuse the exact same handler instance (and therefore the exact same
  // rate/concurrency limiter, see createKnowledgeService above) that
  // /api/v1/knowledge's own singleton export uses, instead of building a
  // second instance with a second, independent budget. server.js's route
  // wiring calls this with two arguments only, so the third parameter is
  // always undefined there and defaultOperationalContextProviderFn (a
  // permanent no-op for the production singleton) applies - this route's
  // behaviour is unchanged.
  return async function handleKnowledge(request, response, {
    operationalContextProviderFn = defaultOperationalContextProviderFn,
    sessionContextProviderFn = defaultSessionContextProviderFn
  } = {}) {
    setHeaders(response);
    if (request.headers?.origin) {
      const payload = transportFailure({ code: "ORIGIN_NOT_ALLOWED" });
      safeLog(eventLogger, "knowledge_rejected", { safeMetadata: { errorCode: "ORIGIN_NOT_ALLOWED" } });
      return sendJson(response, knowledgeAnswerTransportHttpStatus(payload), payload);
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      const payload = transportFailure({ code: "METHOD_NOT_ALLOWED" });
      safeLog(eventLogger, "knowledge_rejected", { safeMetadata: { errorCode: "METHOD_NOT_ALLOWED" } });
      return sendJson(response, knowledgeAnswerTransportHttpStatus(payload), payload);
    }
    try {
      authenticateInternalRequest(request.headers?.authorization, {
        expectedToken: env[KNOWLEDGE_TOKEN_ENV_VAR],
        timingSafeEqualFn
      });
    } catch (authError) {
      const payload = transportFailure(authError);
      safeLog(eventLogger, "knowledge_rejected", { safeMetadata: { errorCode: payload.error.code } });
      return sendJson(response, knowledgeAnswerTransportHttpStatus(payload), payload);
    }
    if (!JSON_CONTENT_TYPE.test(String(request.headers?.["content-type"] || ""))) {
      const payload = transportFailure(new KnowledgeError("VALIDATION_FAILED", "Content-Type must be application/json."));
      safeLog(eventLogger, "knowledge_rejected", { safeMetadata: { errorCode: "VALIDATION_FAILED" } });
      return sendJson(response, knowledgeAnswerTransportHttpStatus(payload), payload);
    }

    const startedAt = Date.now();
    let normalized;
    try {
      const raw = await readJsonBody(request, KNOWLEDGE_MAX_REQUEST_BYTES);
      normalized = normalizeKnowledgeRequest(raw);
    } catch (requestError) {
      const error = requestError instanceof KnowledgeError
        ? requestError
        : new KnowledgeError("VALIDATION_FAILED", "The knowledge request is invalid.", {
          safeDetails: { reason: requestError?.code === "PAYLOAD_TOO_LARGE" ? "request_too_large" : "invalid_request" }
        });
      const payload = transportFailure(error);
      safeLog(eventLogger, "knowledge_rejected", { safeMetadata: { errorCode: payload.error.code } });
      return sendJson(response, knowledgeAnswerTransportHttpStatus(payload), payload);
    }

    // No CC context is passed and none can be: this contract has no such
    // field. The service therefore reports systemContextState "unavailable"
    // and requires at least one cited source whenever it found any - a
    // knowledge answer on this route is never allowed to stand on nothing.
    //
    // operationalContext is a separate, non-contract concept (see
    // knowledge-service.js): the production singleton below never supplies
    // a provider, so this is always null here and the route's behaviour is
    // unchanged. Never allowed to throw or hang the response - a failing or
    // slow provider must degrade to "no operational context", not break
    // knowledge answering.
    let operationalContext = null;
    try {
      operationalContext = (await operationalContextProviderFn(normalized.question)) || null;
    } catch {
      operationalContext = null;
    }

    // Same never-throw-never-hang contract as operationalContext above: a
    // session store lookup failing or taking too long must degrade to "no
    // session context", never break knowledge answering.
    let sessionContext = null;
    try {
      sessionContext = (await sessionContextProviderFn(normalized.question)) || null;
    } catch {
      sessionContext = null;
    }

    const { payload, safeMetadata } = await answerKnowledgeQuestion({ question: normalized.question, operationalContext, sessionContext });

    safeLog(eventLogger, "knowledge_observed", { durationMs: Date.now() - startedAt, safeMetadata });
    return sendJson(response, knowledgeAnswerObservationHttpStatus(payload.warnings), payload);
  };
}

export const handleKnowledgeRequest = createKnowledgeHandler();
