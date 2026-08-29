import {
  TEXT_RESPONSE_PUBLIC_MODEL,
  TEXT_RESPONSE_SCHEMA_VERSION
} from "./text-response-config.js";

const ERROR_CODES = new Set([
  "AUTH_REQUIRED", "AUTH_INVALID", "AUTH_NOT_CONFIGURED", "RATE_LIMITED",
  "CONCURRENCY_LIMITED", "VALIDATION_FAILED", "SECURITY_BLOCKED", "INPUT_TOO_LARGE",
  "TOKEN_LIMIT_EXCEEDED", "COST_LIMIT_EXCEEDED", "NO_SAFE_ROUTE",
  "PROVIDER_NOT_CONFIGURED", "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE",
  "PROVIDER_RESPONSE_INVALID", "INTERNAL_ERROR"
]);
const SAFE_REASONS = new Set([
  "browser_origin_blocked", "body_too_large", "privacy_classification_missing",
  "privacy_classification_invalid", "private_context", "local_only_context",
  "secret_like_content", "execution_request_blocked", "no_safe_route",
  "input_token_limit", "total_token_limit", "worst_case_cost_limit",
  "api_key_missing", "model_configuration_missing", "model_configuration_invalid",
  "cost_configuration_missing", "cost_configuration_invalid", "cost_ceiling_too_high",
  "provider_timeout", "total_timeout", "client_disconnected", "server_aborted",
  "provider_aborted", "provider_network_error", "provider_http_error", "provider_error",
  "provider_json_invalid", "provider_body_too_large", "non_text_provider_output",
  "action_structure_detected", "multiple_text_outputs", "unknown_output_item",
  "provider_response_incomplete", "adapter_result_shape", "usage_metadata_invalid",
  "empty_provider_output", "output_limit_exceeded", "provider_usage_limit_exceeded",
  "html_output_blocked", "control_characters_blocked", "protection_configuration_invalid",
  "structured_output_invalid", "provider_selection_invalid", "base_url_configuration_invalid",
  "redirect_blocked"
]);
const HTTP_STATUS = Object.freeze({
  AUTH_REQUIRED: 403,
  AUTH_INVALID: 403,
  AUTH_NOT_CONFIGURED: 503,
  RATE_LIMITED: 429,
  CONCURRENCY_LIMITED: 429,
  VALIDATION_FAILED: 422,
  SECURITY_BLOCKED: 403,
  INPUT_TOO_LARGE: 413,
  TOKEN_LIMIT_EXCEEDED: 413,
  COST_LIMIT_EXCEEDED: 422,
  NO_SAFE_ROUTE: 422,
  PROVIDER_NOT_CONFIGURED: 503,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_RESPONSE_INVALID: 502,
  INTERNAL_ERROR: 500
});
const SAFE_MESSAGES = Object.freeze({
  AUTH_REQUIRED: "Internal authentication is required.",
  AUTH_INVALID: "Internal authentication failed.",
  AUTH_NOT_CONFIGURED: "Internal authentication is unavailable.",
  RATE_LIMITED: "The internal request rate limit was exceeded.",
  CONCURRENCY_LIMITED: "The concurrent response limit was exceeded.",
  VALIDATION_FAILED: "The text response request is invalid.",
  SECURITY_BLOCKED: "The request was blocked by the response security policy.",
  INPUT_TOO_LARGE: "The text response request exceeds a configured size limit.",
  TOKEN_LIMIT_EXCEEDED: "The text response request exceeds its token budget.",
  COST_LIMIT_EXCEEDED: "The text response request exceeds its cost budget.",
  NO_SAFE_ROUTE: "No safe text response route is available.",
  PROVIDER_NOT_CONFIGURED: "The text provider is not configured.",
  PROVIDER_TIMEOUT: "The text provider request timed out.",
  PROVIDER_UNAVAILABLE: "The text provider is unavailable.",
  PROVIDER_RESPONSE_INVALID: "The text provider returned an invalid response.",
  INTERNAL_ERROR: "The text response request could not be completed."
});

function numeric(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function base({ requestId = null, status, durationMs = 0 }) {
  return {
    schemaVersion: TEXT_RESPONSE_SCHEMA_VERSION,
    requestId,
    status,
    route: null,
    answer: null,
    provider: null,
    error: null,
    meta: {
      durationMs: numeric(durationMs) ?? 0,
      toolCallingAllowed: false,
      actionsExecuted: false,
      inputTokenEstimate: null,
      providerInputTokens: null,
      providerOutputTokens: null,
      providerTotalTokens: null,
      worstCaseCostUsd: null,
      calculatedCostUsd: null
    }
  };
}

export function buildTextResponseSuccess(result, { durationMs = 0 } = {}) {
  const response = base({ requestId: result.request.requestId, status: "answered", durationMs });
  response.route = { ...result.route };
  response.answer = {
    type: result.structured ? "structured_json" : "text",
    text: result.answerText,
    structured: result.structured ?? null,
    trust: "untrusted_provider_text",
    truncated: result.truncated === true
  };
  response.provider = {
    providerId: result.provider.providerId,
    model: TEXT_RESPONSE_PUBLIC_MODEL
  };
  response.meta.inputTokenEstimate = result.inputTokenEstimate;
  response.meta.providerInputTokens = result.usage.inputTokens;
  response.meta.providerOutputTokens = result.usage.outputTokens;
  response.meta.providerTotalTokens = result.usage.totalTokens;
  response.meta.worstCaseCostUsd = result.worstCaseCostUsd;
  response.meta.calculatedCostUsd = result.calculatedCostUsd;
  return response;
}

export function buildTextResponseFailure(error, { requestId = null, durationMs = 0 } = {}) {
  const code = ERROR_CODES.has(error?.code) ? error.code : "INTERNAL_ERROR";
  const response = base({ requestId, status: "failed", durationMs });
  const reason = SAFE_REASONS.has(error?.safeDetails?.reason) ? error.safeDetails.reason : null;
  response.error = {
    code,
    message: SAFE_MESSAGES[code],
    reasonCode: reason,
    retryable: error?.retryable === true
  };
  return response;
}

export function textResponseHttpStatus(payload) {
  return HTTP_STATUS[payload?.error?.code] || 500;
}

export function isSafeTextResponseReasonCode(value) {
  return SAFE_REASONS.has(value);
}

export const textResponseErrorCodes = Object.freeze([...ERROR_CODES]);
