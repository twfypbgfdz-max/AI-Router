import crypto from "node:crypto";
import { readJsonBody } from "./http-utils.js";
import { authenticateInternalRequest } from "./internal-auth.js";
import { CcKnowledgeError } from "./cc-knowledge-error.js";
import { normalizeCcKnowledgeRequest } from "./cc-knowledge-contract.js";
import { retrieveKnowledge } from "./cc-knowledge-rag-service.js";
import { buildCcKnowledgePromptText } from "./cc-knowledge-prompt.js";
import {
  buildCcKnowledgeObservation,
  buildCcKnowledgeTransportFailure,
  ccKnowledgeObservationHttpStatus,
  ccKnowledgeTransportHttpStatus
} from "./cc-knowledge-response.js";
import {
  CC_KNOWLEDGE_ABSOLUTE_TIMEOUT_MS,
  CC_KNOWLEDGE_MAX_ANSWER_BYTES,
  CC_KNOWLEDGE_MAX_CONCURRENT_REQUESTS,
  CC_KNOWLEDGE_MAX_REQUEST_BYTES,
  CC_KNOWLEDGE_MAX_REQUESTS_PER_WINDOW
} from "./cc-knowledge-config.js";
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

function buildInternalRequestId() {
  return `cc-knowledge-${crypto.randomUUID()}`;
}

// A plain internal request object, never a browser fetch - identical pattern
// to cc-summary-handler.js's buildInternalRequest. The full four-block
// prompt (already containing question, system context and knowledge
// snippets) is the only thing sent as input.content; no separate `context`
// field is ever attached to this internal request.
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
      intent: "knowledge_answer",
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

// Maps the shared pipeline's internal failure code to one public,
// closed-vocabulary warning. RATE_LIMITED/CONCURRENCY_LIMITED are this
// endpoint's own scoped limiter, not a provider problem - kept distinct so
// ccKnowledgeObservationHttpStatus can still return a real 429 for them.
function mapGenerationFailureWarning(generationPayload) {
  const code = generationPayload.error?.code;
  if (code === "RATE_LIMITED") return "rate_limited";
  if (code === "CONCURRENCY_LIMITED") return "concurrency_limited";
  if (code === "PROVIDER_TIMEOUT" || code === "PROVIDER_UNAVAILABLE") return "answer_provider_unavailable";
  if (code === "PROVIDER_NOT_CONFIGURED") return "answer_model_unavailable";
  if (code === "PROVIDER_RESPONSE_INVALID") return "model_response_invalid";
  if (code === "TOKEN_LIMIT_EXCEEDED" || code === "INPUT_TOO_LARGE") return "prompt_budget_exceeded";
  return "internal_error";
}

// Server is the sole authority over source identity: K1..K3 map to
// results[0..2] purely by position for this one request. The model may only
// ever choose which of the offered IDs to cite - it can never supply or
// override sourceDoc, section, similarity, freshness, docStatus or
// docVersion, because those values are never read from the model's output
// at all, only from `results` (server-built RAG search results).
function validateCitedSources(citedSources, results, { requireAtLeastOne }) {
  const validIds = results.map((_, index) => `K${index + 1}`);
  for (const id of citedSources) {
    if (!validIds.includes(id)) return { ok: false, internalReason: "model_cited_unknown_source" };
  }
  if (requireAtLeastOne && citedSources.length === 0) {
    return { ok: false, internalReason: "model_missing_required_source" };
  }
  const sources = citedSources.map((id) => {
    const result = results[validIds.indexOf(id)];
    return {
      sourceDoc: result.sourceDoc,
      section: result.section,
      docStatus: result.docStatus,
      docVersion: result.docVersion,
      similarity: result.similarity,
      freshness: result.freshness
    };
  });
  return { ok: true, sources };
}

// Narrow, first-person-only action-claim detection. Deliberately does not
// match bare topic words (Commit/Push/Shell/geändert) on their own - those
// occur legitimately in governance answers that describe or quote a rule
// (e.g. "DEC-002 regelt, wann ein Commit erlaubt ist") - only a first-person
// claim of having personally performed the action is blocked.
const ACTION_CLAIM_PATTERNS = Object.freeze([
  /\bich (?:habe|hab)\b[^.?!\n]{0,60}\b(?:neu gestartet|committed|gepusht|geändert|erstellt|gelöscht|bereitgestellt|deployed)\b/i,
  /\bi (?:have|'ve) (?:just )?(?:restarted|pushed|committed|deployed|deleted|created|changed)\b/i,
  /\bi (?:restarted|pushed|committed|deployed|deleted|created|changed) (?:the|it|that)\b/i
]);
function containsActionClaim(text) {
  return ACTION_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

// Structurally, `answer` is already validated as a plain JSON string by
// structured-response-schema.js - a real tool-call object can never appear
// there. This only catches a tool-call-shaped substring embedded as text
// inside that string, as an additional hard-blocked defense-in-depth layer.
const TOOL_CALL_TEXT_PATTERN = /"tool_calls"\s*:|"function_call"\s*:/i;

const URL_PATTERN = /https?:\/\//i;
const ABSOLUTE_PATH_PATTERN = /[A-Za-z]:\\|(?:^|\s)\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/;
const COMMAND_REFERENCE_PATTERN = /\bgit (?:push|commit|merge|rebase|reset)\b|powershell\.exe|cmd\.exe|\brm -rf\b|\bnpm install\b|\bpip install\b/i;

export function createCcKnowledgeHandler({
  env = process.env,
  timingSafeEqualFn,
  now = () => new Date(),
  eventLogger = defaultLogger,
  retrieveKnowledgeFn = retrieveKnowledge,
  // Test-only seams: production never overrides these.
  adapterFactory,
  totalTimeoutMs = CC_KNOWLEDGE_ABSOLUTE_TIMEOUT_MS
} = {}) {
  // Forces Ollama regardless of the shared AI_ROUTER_TEXT_PROVIDER switch,
  // and scopes this endpoint's concurrency/rate limits independently of
  // /api/router/respond and /api/v1/cc/summary - both via existing,
  // already-tested env-driven knobs. No new limiter, no second Ollama
  // client, no core file touched.
  const scopedEnv = Object.freeze({
    ...env,
    AI_ROUTER_TEXT_PROVIDER: "ollama",
    AI_ROUTER_MAX_CONCURRENT_REQUESTS: String(CC_KNOWLEDGE_MAX_CONCURRENT_REQUESTS),
    AI_ROUTER_MAX_REQUESTS_PER_MINUTE: String(CC_KNOWLEDGE_MAX_REQUESTS_PER_WINDOW)
  });
  const textResponseHandler = createTextResponseHandler({
    env: scopedEnv,
    adapterFactory,
    forcedIntent: "knowledge_answer",
    totalTimeoutMs
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

    const systemContextState = normalized.context !== null ? "available" : "unavailable";
    const knowledge = await retrieveKnowledgeFn(normalized.question, { env: scopedEnv });
    const { knowledgeState, results } = knowledge;

    function finish(payload, extraMeta = {}) {
      const status = ccKnowledgeObservationHttpStatus(payload.warnings);
      safeLog(eventLogger, "cc_knowledge_observed", {
        requestId: null,
        durationMs: Date.now() - startedAt,
        safeMetadata: {
          state: payload.state,
          systemContextState: payload.systemContextState,
          knowledgeState: payload.knowledgeState,
          resultCount: results.length,
          sourceCount: payload.sources.length,
          citedSourceIds: payload.sources.length ? "present" : "none",
          answerLength: payload.answer ? payload.answer.length : 0,
          ...extraMeta
        }
      });
      return sendJson(response, status, payload);
    }

    // No usable basis at all: no context, no knowledge match. Answering
    // would mean either general knowledge (forbidden - no free chat) or
    // fabrication. No provider call is made.
    if (systemContextState === "unavailable" && results.length === 0) {
      return finish(buildCcKnowledgeObservation({
        state: "unavailable", systemContextState, knowledgeState, warnings: ["no_context_no_knowledge"], now
      }));
    }

    const promptText = buildCcKnowledgePromptText({ question: normalized.question, context: normalized.context, results });
    const internalRequest = buildInternalRequest(promptText, scopedEnv.AI_ROUTER_INTERNAL_TOKEN);
    const internalResponse = captureResponse();
    const generationPayload = await textResponseHandler(internalRequest, internalResponse);

    if (generationPayload.status !== "answered") {
      const warning = mapGenerationFailureWarning(generationPayload);
      return finish(buildCcKnowledgeObservation({
        state: "unavailable", systemContextState, knowledgeState, warnings: [warning], now
      }), { errorCode: warning });
    }

    // The shared service already ran parseStructuredReport("knowledge_answer", ...)
    // fail-closed before reaching "answered" - structured is always a valid
    // {answer, citedSources} object here, never re-validated ad hoc.
    const { answer: rawAnswer, citedSources } = generationPayload.answer.structured;

    const requireAtLeastOne = systemContextState === "unavailable" && results.length > 0;
    const sourceValidation = validateCitedSources(citedSources, results, { requireAtLeastOne });
    if (!sourceValidation.ok) {
      return finish(buildCcKnowledgeObservation({
        state: "unavailable", systemContextState, knowledgeState, warnings: ["model_source_validation_failed"], now
      }), { errorCode: sourceValidation.internalReason });
    }

    if (Buffer.byteLength(rawAnswer, "utf8") > CC_KNOWLEDGE_MAX_ANSWER_BYTES) {
      return finish(buildCcKnowledgeObservation({
        state: "unavailable", systemContextState, knowledgeState, warnings: ["model_answer_too_large"], now
      }));
    }
    if (containsActionClaim(rawAnswer)) {
      return finish(buildCcKnowledgeObservation({
        state: "unavailable", systemContextState, knowledgeState, warnings: ["model_action_claim_blocked"], now
      }));
    }
    if (TOOL_CALL_TEXT_PATTERN.test(rawAnswer)) {
      return finish(buildCcKnowledgeObservation({
        state: "unavailable", systemContextState, knowledgeState, warnings: ["model_tool_call_output_blocked"], now
      }));
    }

    const warnings = [];
    if (knowledgeState === "index_stale") warnings.push("index_stale");
    if (knowledgeState === "index_missing") warnings.push("index_missing");
    if (knowledgeState === "embedding_model_unavailable") warnings.push("embedding_model_unavailable");
    if (knowledgeState === "search_failed") warnings.push("search_failed");
    if (URL_PATTERN.test(rawAnswer) || ABSOLUTE_PATH_PATTERN.test(rawAnswer)) warnings.push("model_output_contains_path_or_url");
    if (COMMAND_REFERENCE_PATTERN.test(rawAnswer)) warnings.push("model_output_contains_command_reference");

    // "ok" requires both a fresh, available knowledge base AND an available
    // system context; every other combination that reached this point
    // (context-only, knowledge-only, stale index, technically degraded RAG
    // with context still present) is "partial" - a single rule that covers
    // every case in the state matrix without a long if/else chain.
    const state = systemContextState === "available" && knowledgeState === "available" ? "ok" : "partial";

    return finish(buildCcKnowledgeObservation({
      state, answer: rawAnswer, systemContextState, knowledgeState, sources: sourceValidation.sources, warnings, now
    }));
  };
}

export const handleCcKnowledgeRequest = createCcKnowledgeHandler();

export const ccKnowledgeHandlerInternals = Object.freeze({
  mapGenerationFailureWarning,
  validateCitedSources,
  containsActionClaim
});
