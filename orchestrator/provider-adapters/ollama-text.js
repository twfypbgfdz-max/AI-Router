import { TextResponseError } from "../text-response-error.js";

export const DEFAULT_BASE_URL = "http://localhost:11434";
const MAX_PROVIDER_BODY_BYTES = 1_048_576;
const ADAPTER_INPUT_FIELDS = new Set(["instructions", "question", "context", "maxOutputTokens", "signal"]);
const ADAPTER_RESULT_FIELDS = new Set(["text", "usage"]);
const USAGE_FIELDS = new Set(["inputTokens", "outputTokens", "totalTokens"]);
const MESSAGE_FIELDS = new Set(["role", "content"]);

function exactFields(value, allowed, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TextResponseError(code, message);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new TextResponseError(code, message);
}

function requiredSignal(value) {
  if (!value || typeof value.aborted !== "boolean" || typeof value.addEventListener !== "function") {
    throw new TextResponseError("INTERNAL_ERROR", "Provider abort signal is required.");
  }
  return value;
}

function providerMessages(instructions, question, context) {
  const messages = [
    { role: "system", content: instructions },
    { role: "user", content: question }
  ];
  if (context) messages.push({ role: "user", content: context });
  return messages;
}

function numericUsage(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider usage metadata is invalid.", {
      safeDetails: { reason: "usage_metadata_invalid", field }
    });
  }
  return value;
}

function extractUsage(payload) {
  const inputTokens = numericUsage(payload.prompt_eval_count, "prompt_eval_count");
  const outputTokens = numericUsage(payload.eval_count, "eval_count");
  const totalTokens = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  return Object.freeze({ inputTokens, outputTokens, totalTokens });
}

function invalidProviderOutput(reason, message = "Provider response did not contain one plain-text message.") {
  throw new TextResponseError("PROVIDER_RESPONSE_INVALID", message, { safeDetails: { reason } });
}

// Fail-closed parsing: only a single, complete assistant text message is
// accepted. Tool calls or any other structure are rejected, mirroring the
// OpenAI adapter's stance that this endpoint only ever returns plain text.
function extractText(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalidProviderOutput("non_text_provider_output");
  if (payload.done !== undefined && payload.done !== true) {
    invalidProviderOutput("provider_response_incomplete", "Provider response was not complete.");
  }
  if (payload.tool_calls !== undefined) {
    invalidProviderOutput("action_structure_detected", "Provider response contained unsupported action structures.");
  }
  const message = payload.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) invalidProviderOutput("non_text_provider_output");
  if (Object.keys(message).some((key) => !MESSAGE_FIELDS.has(key))) {
    invalidProviderOutput("action_structure_detected", "Provider response contained unsupported message fields.");
  }
  if (message.role !== "assistant") invalidProviderOutput("non_text_provider_output");
  if (typeof message.content !== "string") {
    invalidProviderOutput("non_text_provider_output", "Provider response did not contain plain text.");
  }
  if (!message.content.trim()) invalidProviderOutput("empty_provider_output", "Provider response text was empty.");
  return message.content;
}

async function readProviderJson(response) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_BODY_BYTES) {
    response.body?.cancel?.().catch?.(() => {});
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response exceeded its transport limit.", {
      safeDetails: { reason: "provider_body_too_large" }
    });
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_PROVIDER_BODY_BYTES) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response exceeded its transport limit.", {
      safeDetails: { reason: "provider_body_too_large" }
    });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response was not valid JSON.", {
      safeDetails: { reason: "provider_json_invalid" }
    });
  }
}

function normalizeFetchError(error, signal) {
  if (error instanceof TextResponseError) return error;
  if (signal.aborted) {
    if (signal.reason instanceof TextResponseError) return signal.reason;
    return new TextResponseError("PROVIDER_TIMEOUT", "Provider request was aborted.", {
      safeDetails: { reason: "provider_aborted" }
    });
  }
  // Covers Ollama not running / not reachable (connection refused, DNS, etc.).
  return new TextResponseError("PROVIDER_UNAVAILABLE", "The text provider is unavailable.", {
    retryable: false,
    safeDetails: { reason: "provider_network_error" }
  });
}

export function createOllamaTextAdapter({ model, baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
  if (typeof model !== "string" || !model || typeof baseUrl !== "string" || !baseUrl || typeof fetchImpl !== "function") {
    throw new TextResponseError("PROVIDER_NOT_CONFIGURED", "The text provider is not configured.");
  }
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/api/chat`;
  return Object.freeze({
    async generateText(input) {
      exactFields(input, ADAPTER_INPUT_FIELDS, "INTERNAL_ERROR", "Provider adapter input is invalid.");
      if (typeof input.instructions !== "string" || !input.instructions
        || typeof input.question !== "string" || !input.question
        || (input.context !== null && typeof input.context !== "string")
        || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) {
        throw new TextResponseError("INTERNAL_ERROR", "Provider adapter input is invalid.");
      }
      const signal = requiredSignal(input.signal);
      const providerRequest = {
        model,
        messages: providerMessages(input.instructions, input.question, input.context),
        stream: false,
        options: { num_predict: input.maxOutputTokens }
      };
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(providerRequest),
          signal
        });
        if (!response?.ok) {
          response?.body?.cancel?.().catch?.(() => {});
          throw new TextResponseError("PROVIDER_UNAVAILABLE", "The text provider is unavailable.", {
            retryable: false,
            safeDetails: { reason: "provider_http_error" }
          });
        }
        const payload = await readProviderJson(response);
        const result = Object.freeze({ text: extractText(payload), usage: extractUsage(payload) });
        exactFields(result, ADAPTER_RESULT_FIELDS, "PROVIDER_RESPONSE_INVALID", "Provider response is invalid.");
        exactFields(result.usage, USAGE_FIELDS, "PROVIDER_RESPONSE_INVALID", "Provider usage metadata is invalid.");
        return result;
      } catch (error) {
        throw normalizeFetchError(error, signal);
      }
    }
  });
}

export const ollamaTextAdapterInternals = Object.freeze({
  defaultBaseUrl: DEFAULT_BASE_URL,
  extractText,
  extractUsage
});
