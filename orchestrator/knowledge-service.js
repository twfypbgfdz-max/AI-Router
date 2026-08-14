import crypto from "node:crypto";
import { retrieveKnowledge } from "./knowledge-answer-rag-service.js";
import { buildKnowledgeAnswerPromptText } from "./knowledge-answer-prompt.js";
import { buildKnowledgeAnswerObservation } from "./knowledge-answer-response.js";
import { KNOWLEDGE_ANSWER_MAX_BYTES } from "./knowledge-answer-config.js";
import { createTextResponseHandler } from "./text-response-handler.js";
// Ordering is not applied here: buildKnowledgeAnswerObservation is the one
// place every path passes through, so it ranks the warnings itself.
import {
  deriveAuthorityWarnings,
  isImplementationAlignmentQuestion,
  isPresentStateQuestion,
  withImplementationAlignmentDisclaimer
} from "./knowledge-authority.js";

// The generic, read-only knowledge engine. Everything that turns an
// already-validated question (plus an optional caller-supplied system
// context) into a closed observation payload lives here, and nothing else:
// no HTTP, no authentication, no request parsing, no route-specific
// logging. This module was extracted verbatim out of what was then
// cc-knowledge-handler.js (2026-08-11) so that a second consumer (the local
// Jarvis dialogue surface) can reuse
// the exact same answering path instead of the Command Center contract
// being quietly repurposed for it.
//
// Read-only by construction: it retrieves from the already-built local
// index and the retrieval layer verifies allowlisted vault documents by
// hash. It never triggers an index run and never writes anything. It
// performs no action and returns no tool call - the only thing it produces
// is text plus server-validated sources.
//
// Deliberately NOT here (and therefore per-consumer):
// - authentication and which token guards a route
// - the request contract (whether a `context` field exists at all)
// - the transport envelope and HTTP status mapping
// - the rate/concurrency budget, which every consumer sizes for itself
//
// Provider policy is fixed and not a caller choice: AI_ROUTER_TEXT_PROVIDER
// is forced to "ollama" below, so personal knowledge content can never be
// sent to a cloud provider regardless of the shared provider switch. No new
// provider logic is introduced - this is the same env-driven knob the
// Command Center path already used.

// Maps the shared pipeline's internal failure code to one public,
// closed-vocabulary warning. RATE_LIMITED/CONCURRENCY_LIMITED are the
// calling route's own scoped limiter, not a provider problem - kept
// distinct so a route can still return a real 429 for them.
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

function indexWarnings({ knowledgeState, indexVerification }) {
  const warnings = [];
  if (knowledgeState === "index_stale") warnings.push("index_stale");
  if (knowledgeState === "index_missing") warnings.push("index_missing");
  if (knowledgeState === "embedding_model_unavailable") warnings.push("embedding_model_unavailable");
  if (knowledgeState === "search_failed") warnings.push("search_failed");
  if (indexVerification?.state === "index_incompatible") warnings.push("index_incompatible");
  if (indexVerification?.state === "index_error" && knowledgeState !== "index_missing") warnings.push("index_error");
  if (indexVerification?.ageWarning === true) warnings.push("index_age_warning");
  if (indexVerification?.state === "content_current" && indexVerification?.modelDigestVerified === false) {
    warnings.push("embedding_model_identity_unverified");
  }
  return [...new Set(warnings)];
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
      freshness: result.freshness,
      // Server-owned authority metadata, carried alongside the response
      // fields for warning derivation only. buildKnowledgeAnswerObservation
      // rebuilds each source from its own fixed six-field list, so these two
      // never reach the wire and the response schema is unchanged.
      informationClass: result.informationClass,
      sectionValidity: result.sectionValidity
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

function buildInternalRequestId(requestIdPrefix) {
  return `${requestIdPrefix}-${crypto.randomUUID()}`;
}

// A plain internal request object, never a browser fetch. The full
// four-block prompt (already containing question, system context and
// knowledge snippets) is the only thing sent as input.content; no separate
// `context` field is ever attached to this internal request.
function buildInternalRequest(promptText, internalToken, requestIdPrefix) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(internalToken ? { authorization: `Bearer ${internalToken}` } : {})
    },
    body: {
      schemaVersion: "1.0",
      requestId: buildInternalRequestId(requestIdPrefix),
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

export function createKnowledgeService({
  env = process.env,
  now = () => new Date(),
  retrieveKnowledgeFn = retrieveKnowledge,
  maxConcurrentRequests,
  maxRequestsPerWindow,
  totalTimeoutMs,
  maxAnswerBytes = KNOWLEDGE_ANSWER_MAX_BYTES,
  schemaVersion,
  requestIdPrefix = "knowledge",
  // Test-only seam: production never overrides this.
  adapterFactory
} = {}) {
  // Forces Ollama regardless of the shared AI_ROUTER_TEXT_PROVIDER switch,
  // and scopes this consumer's concurrency/rate limits independently of
  // every other route - both via existing, already-tested env-driven knobs.
  // Each createKnowledgeService call builds its own text-response handler
  // and therefore its own in-memory limiter, so two consumers never share
  // or exhaust each other's budget.
  const scopedEnv = Object.freeze({
    ...env,
    AI_ROUTER_TEXT_PROVIDER: "ollama",
    AI_ROUTER_MAX_CONCURRENT_REQUESTS: String(maxConcurrentRequests),
    AI_ROUTER_MAX_REQUESTS_PER_MINUTE: String(maxRequestsPerWindow)
  });
  const textResponseHandler = createTextResponseHandler({
    env: scopedEnv,
    adapterFactory,
    forcedIntent: "knowledge_answer",
    totalTimeoutMs
  });

  // question and context must already be validated by the caller's own
  // request contract - this function never re-validates and never accepts
  // raw request data.
  return async function answerKnowledgeQuestion({ question, context = null }) {
    const knowledge = await retrieveKnowledgeFn(question, { env: scopedEnv });
    const { knowledgeState, results, indexVerification = null } = knowledge;
    const freshnessWarnings = indexWarnings(knowledge);
    const systemContextState = context !== null ? "available" : "unavailable";
    // Evaluated once, on the caller's already-validated question only -
    // never on the retrieved evidence, so a snippet containing the word
    // "aktuell" cannot make an unrelated question look time-dependent.
    const presentStateQuestion = isPresentStateQuestion(question);
    // A distinct signal (see knowledge-authority.js): "entspricht die
    // Implementierung dem?" carries none of the present-state keywords, so
    // it needs its own detection and its own unconditional hedge.
    const implementationAlignmentQuestion = isImplementationAlignmentQuestion(question);

    const finish = (payload, extraMeta = {}) => Object.freeze({
      payload,
      resultCount: results.length,
      safeMetadata: Object.freeze({
        state: payload.state,
        systemContextState: payload.systemContextState,
        knowledgeState: payload.knowledgeState,
        resultCount: results.length,
        sourceCount: payload.sources.length,
        citedSourceIds: payload.sources.length ? "present" : "none",
        answerLength: payload.answer ? payload.answer.length : 0,
        indexState: indexVerification?.state || null,
        indexAgeWarning: indexVerification?.ageWarning === true,
        indexLastBuiltAt: indexVerification?.lastBuiltAt || null,
        indexLastVerifiedAt: indexVerification?.lastVerifiedAt || null,
        presentStateQuestion,
        implementationAlignmentQuestion,
        ...extraMeta
      })
    });

    // No usable basis at all: no context, no knowledge match. Answering
    // would mean either general knowledge (forbidden - no free chat) or
    // fabrication. No provider call is made.
    if (systemContextState === "unavailable" && results.length === 0) {
      return finish(buildKnowledgeAnswerObservation({
        state: "unavailable", systemContextState, knowledgeState,
        warnings: [
          "no_context_no_knowledge",
          ...freshnessWarnings,
          ...deriveAuthorityWarnings({ presentStateQuestion, implementationAlignmentQuestion, sources: [] })
        ],
        now, schemaVersion
      }));
    }

    const promptText = buildKnowledgeAnswerPromptText({ question, context, results, presentStateQuestion, implementationAlignmentQuestion });
    const internalRequest = buildInternalRequest(promptText, scopedEnv.AI_ROUTER_INTERNAL_TOKEN, requestIdPrefix);
    const internalResponse = captureResponse();
    // The provider receives the full grounded prompt, but execution intent is
    // evaluated only against the caller's already-validated question. This
    // prevents command references inside retrieved evidence from being
    // mistaken for a user instruction while preserving the same hard block
    // for an actual execution request.
    const generationPayload = await textResponseHandler(internalRequest, internalResponse, {
      executionRequestText: question
    });

    if (generationPayload.status !== "answered") {
      const warning = mapGenerationFailureWarning(generationPayload);
      return finish(buildKnowledgeAnswerObservation({
        state: "unavailable", systemContextState, knowledgeState,
        warnings: [warning, ...freshnessWarnings], now, schemaVersion
      }), { errorCode: warning });
    }

    // The shared service already ran parseStructuredReport("knowledge_answer", ...)
    // fail-closed before reaching "answered" - structured is always a valid
    // {answer, citedSources} object here, never re-validated ad hoc.
    const { answer: rawAnswer, citedSources } = generationPayload.answer.structured;

    const requireAtLeastOne = systemContextState === "unavailable" && results.length > 0;
    const sourceValidation = validateCitedSources(citedSources, results, { requireAtLeastOne });
    if (!sourceValidation.ok) {
      return finish(buildKnowledgeAnswerObservation({
        state: "unavailable", systemContextState, knowledgeState, warnings: ["model_source_validation_failed"], now, schemaVersion
      }), { errorCode: sourceValidation.internalReason });
    }

    if (Buffer.byteLength(rawAnswer, "utf8") > maxAnswerBytes) {
      return finish(buildKnowledgeAnswerObservation({
        state: "unavailable", systemContextState, knowledgeState, warnings: ["model_answer_too_large"], now, schemaVersion
      }));
    }
    if (containsActionClaim(rawAnswer)) {
      return finish(buildKnowledgeAnswerObservation({
        state: "unavailable", systemContextState, knowledgeState, warnings: ["model_action_claim_blocked"], now, schemaVersion
      }));
    }
    if (TOOL_CALL_TEXT_PATTERN.test(rawAnswer)) {
      return finish(buildKnowledgeAnswerObservation({
        state: "unavailable", systemContextState, knowledgeState, warnings: ["model_tool_call_output_blocked"], now, schemaVersion
      }));
    }

    // Derived from the sources the server validated as actually cited, not
    // from the answer prose: these say what the answer is allowed to rest
    // on, which is a server fact, while what it claims is not.
    const warnings = [
      ...freshnessWarnings,
      ...deriveAuthorityWarnings({ presentStateQuestion, implementationAlignmentQuestion, sources: sourceValidation.sources })
    ];
    if (URL_PATTERN.test(rawAnswer) || ABSOLUTE_PATH_PATTERN.test(rawAnswer)) warnings.push("model_output_contains_path_or_url");
    if (COMMAND_REFERENCE_PATTERN.test(rawAnswer)) warnings.push("model_output_contains_command_reference");

    // "ok" requires both a fresh, available knowledge base AND an available
    // system context; every other combination that reached this point
    // (context-only, knowledge-only, stale index, technically degraded RAG
    // with context still present) is "partial" - a single rule that covers
    // every case in the state matrix without a long if/else chain.
    const state = systemContextState === "available" && knowledgeState === "available" ? "ok" : "partial";

    // Measured 2026-08-14: the prompt notice and rule alone did not
    // reliably make the model name the Ist side as unverifiable (see
    // knowledge-authority.js). This appends a fixed, server-authored
    // sentence unconditionally on top of the already-validated rawAnswer -
    // a deterministic guarantee, not a further prompting attempt.
    const finalAnswer = withImplementationAlignmentDisclaimer(rawAnswer, implementationAlignmentQuestion);

    return finish(buildKnowledgeAnswerObservation({
      state, answer: finalAnswer, systemContextState, knowledgeState, sources: sourceValidation.sources, warnings, now, schemaVersion
    }));
  };
}

export const knowledgeServiceInternals = Object.freeze({
  mapGenerationFailureWarning,
  indexWarnings,
  validateCitedSources,
  containsActionClaim
});
