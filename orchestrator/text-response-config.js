import { DEFAULT_BASE_URL as OLLAMA_DEFAULT_BASE_URL } from "./provider-adapters/ollama-text.js";
import { TextResponseError } from "./text-response-error.js";

export const TEXT_RESPONSE_SCHEMA_VERSION = "1.0";
export const TEXT_RESPONSE_PROVIDER_ID = "openai-text-v1";
export const TEXT_RESPONSE_MODEL_ALIAS = "configured-openai-text";
export const TEXT_RESPONSE_PUBLIC_MODEL = "server-configured";

// Which text-generation provider is actually called is controlled by exactly
// one place: the AI_ROUTER_TEXT_PROVIDER environment variable, read here and
// nowhere else. Defaults to "openai" so existing deployments and tests keep
// their current behaviour unless this variable is set explicitly.
export const TEXT_RESPONSE_PROVIDER_SELECTION_ENV = "AI_ROUTER_TEXT_PROVIDER";
export const TEXT_RESPONSE_ALLOWED_PROVIDERS = Object.freeze(["openai", "ollama"]);
export const TEXT_RESPONSE_DEFAULT_PROVIDER = "openai";

export const OLLAMA_TEXT_PROVIDER_ID = "ollama-text-v1";
export const OLLAMA_TEXT_MODEL_ALIAS = "configured-ollama-text";
export const OLLAMA_TEXT_DEFAULT_BASE_URL = OLLAMA_DEFAULT_BASE_URL;
export const OLLAMA_TEXT_DEFAULT_TIMEOUT_MS = 60_000;
export const TEXT_RESPONSE_MAX_BODY_BYTES = 16_384;
export const TEXT_RESPONSE_MAX_QUESTION_CHARS = 8_000;
export const TEXT_RESPONSE_MAX_CONTEXT_CHARS = 4_000;
export const TEXT_RESPONSE_MAX_COMBINED_CHARS = 12_000;
export const TEXT_RESPONSE_MAX_INPUT_TOKENS = 4_000;
export const TEXT_RESPONSE_MAX_OUTPUT_TOKENS = 800;
export const TEXT_RESPONSE_MAX_TOTAL_TOKENS = 4_800;
export const TEXT_RESPONSE_MAX_OUTPUT_CHARS = 8_000;
export const TEXT_RESPONSE_DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
// Outer ceiling for the whole request (body parse + provider call + response
// build). Must exceed the slowest configured provider timeout (Ollama: up to
// OLLAMA_TEXT_DEFAULT_TIMEOUT_MS = 60_000) so a provider's own timeout fires
// first with a clear PROVIDER_TIMEOUT, instead of this generic total_timeout.
// Raising this globally does not change how long a request waits on a dead
// provider - that is still bounded by each provider's own inner timeoutMs
// (OpenAI: capped at TEXT_RESPONSE_DEFAULT_PROVIDER_TIMEOUT_MS = 15_000,
// unchanged) - it only avoids killing a healthy but slow local model early.
export const TEXT_RESPONSE_TOTAL_TIMEOUT_MS = 65_000;
export const TEXT_RESPONSE_DEFAULT_RATE_LIMIT = 10;
export const TEXT_RESPONSE_DEFAULT_CONCURRENCY_LIMIT = 2;
export const TEXT_RESPONSE_RATE_WINDOW_MS = 60_000;
export const TEXT_RESPONSE_MAX_COST_USD = 0.02;

function configuredInteger(value, fallback, maximum, field) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new TextResponseError("INTERNAL_ERROR", "Response protection configuration is invalid.", {
      safeDetails: { reason: "protection_configuration_invalid", field }
    });
  }
  return parsed;
}

function configuredPositiveNumber(value, field) {
  if (value === undefined || value === null || value === "") {
    throw new TextResponseError("PROVIDER_NOT_CONFIGURED", "The text provider is not configured.", {
      safeDetails: { reason: "cost_configuration_missing", field }
    });
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new TextResponseError("PROVIDER_NOT_CONFIGURED", "The text provider is not configured.", {
      safeDetails: { reason: "cost_configuration_invalid", field }
    });
  }
  return parsed;
}

export function loadTextResponseProtectionConfig(env = process.env) {
  return Object.freeze({
    maxRequestsPerMinute: configuredInteger(
      env.AI_ROUTER_MAX_REQUESTS_PER_MINUTE,
      TEXT_RESPONSE_DEFAULT_RATE_LIMIT,
      TEXT_RESPONSE_DEFAULT_RATE_LIMIT,
      "AI_ROUTER_MAX_REQUESTS_PER_MINUTE"
    ),
    maxConcurrentRequests: configuredInteger(
      env.AI_ROUTER_MAX_CONCURRENT_REQUESTS,
      TEXT_RESPONSE_DEFAULT_CONCURRENCY_LIMIT,
      TEXT_RESPONSE_DEFAULT_CONCURRENCY_LIMIT,
      "AI_ROUTER_MAX_CONCURRENT_REQUESTS"
    )
  });
}

// The single, explicit provider-selection switch. Nothing else in the
// codebase decides which text-generation provider is active.
export function loadTextResponseProviderId(env = process.env) {
  const raw = typeof env[TEXT_RESPONSE_PROVIDER_SELECTION_ENV] === "string"
    ? env[TEXT_RESPONSE_PROVIDER_SELECTION_ENV].trim().toLowerCase()
    : "";
  const providerId = raw || TEXT_RESPONSE_DEFAULT_PROVIDER;
  if (!TEXT_RESPONSE_ALLOWED_PROVIDERS.includes(providerId)) {
    throw new TextResponseError("PROVIDER_NOT_CONFIGURED", "The text provider is not configured.", {
      safeDetails: { reason: "provider_selection_invalid", field: TEXT_RESPONSE_PROVIDER_SELECTION_ENV }
    });
  }
  return providerId;
}

export function loadOpenAITextProviderConfig(env = process.env) {
  const apiKey = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  const model = typeof env.AI_ROUTER_OPENAI_MODEL === "string" ? env.AI_ROUTER_OPENAI_MODEL.trim() : "";
  if (apiKey.length < 20) {
    throw new TextResponseError("PROVIDER_NOT_CONFIGURED", "The text provider is not configured.", {
      safeDetails: { reason: "api_key_missing" }
    });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model)) {
    throw new TextResponseError("PROVIDER_NOT_CONFIGURED", "The text provider is not configured.", {
      safeDetails: { reason: model ? "model_configuration_invalid" : "model_configuration_missing" }
    });
  }

  const inputUsdPerMillionTokens = configuredPositiveNumber(
    env.AI_ROUTER_OPENAI_INPUT_USD_PER_MILLION_TOKENS,
    "AI_ROUTER_OPENAI_INPUT_USD_PER_MILLION_TOKENS"
  );
  const outputUsdPerMillionTokens = configuredPositiveNumber(
    env.AI_ROUTER_OPENAI_OUTPUT_USD_PER_MILLION_TOKENS,
    "AI_ROUTER_OPENAI_OUTPUT_USD_PER_MILLION_TOKENS"
  );
  const maxCostUsd = configuredPositiveNumber(env.AI_ROUTER_MAX_COST_USD, "AI_ROUTER_MAX_COST_USD");
  if (maxCostUsd > TEXT_RESPONSE_MAX_COST_USD) {
    throw new TextResponseError("PROVIDER_NOT_CONFIGURED", "The text provider is not configured.", {
      safeDetails: { reason: "cost_ceiling_too_high", field: "AI_ROUTER_MAX_COST_USD" }
    });
  }

  const timeoutMs = configuredInteger(
    env.AI_ROUTER_PROVIDER_TIMEOUT_MS,
    TEXT_RESPONSE_DEFAULT_PROVIDER_TIMEOUT_MS,
    TEXT_RESPONSE_DEFAULT_PROVIDER_TIMEOUT_MS,
    "AI_ROUTER_PROVIDER_TIMEOUT_MS"
  );
  return Object.freeze({
    providerId: TEXT_RESPONSE_PROVIDER_ID,
    apiKey,
    model,
    modelAlias: TEXT_RESPONSE_MODEL_ALIAS,
    publicModel: TEXT_RESPONSE_PUBLIC_MODEL,
    timeoutMs,
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
    maxCostUsd
  });
}

// Ollama runs locally with no per-token price, so its cost fields are fixed
// at zero rather than read from the environment (nothing to misconfigure).
export function loadOllamaTextProviderConfig(env = process.env) {
  const model = typeof env.AI_ROUTER_OLLAMA_MODEL === "string" ? env.AI_ROUTER_OLLAMA_MODEL.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(model)) {
    throw new TextResponseError("PROVIDER_NOT_CONFIGURED", "The text provider is not configured.", {
      safeDetails: { reason: model ? "model_configuration_invalid" : "model_configuration_missing" }
    });
  }
  const baseUrlRaw = typeof env.AI_ROUTER_OLLAMA_BASE_URL === "string" ? env.AI_ROUTER_OLLAMA_BASE_URL.trim() : "";
  const baseUrl = baseUrlRaw || OLLAMA_TEXT_DEFAULT_BASE_URL;
  if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(baseUrl)) {
    throw new TextResponseError("PROVIDER_NOT_CONFIGURED", "The text provider is not configured.", {
      safeDetails: { reason: "base_url_configuration_invalid" }
    });
  }
  const timeoutMs = configuredInteger(
    env.AI_ROUTER_OLLAMA_TIMEOUT_MS,
    OLLAMA_TEXT_DEFAULT_TIMEOUT_MS,
    OLLAMA_TEXT_DEFAULT_TIMEOUT_MS,
    "AI_ROUTER_OLLAMA_TIMEOUT_MS"
  );
  return Object.freeze({
    providerId: OLLAMA_TEXT_PROVIDER_ID,
    model,
    baseUrl,
    modelAlias: OLLAMA_TEXT_MODEL_ALIAS,
    publicModel: TEXT_RESPONSE_PUBLIC_MODEL,
    timeoutMs,
    inputUsdPerMillionTokens: 0,
    outputUsdPerMillionTokens: 0,
    maxCostUsd: TEXT_RESPONSE_MAX_COST_USD
  });
}
