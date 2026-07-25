import { TextResponseError } from "../text-response-error.js";

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_PROVIDER_BODY_BYTES = 1_048_576;
const ADAPTER_INPUT_FIELDS = new Set(["instructions", "question", "context", "maxOutputTokens", "signal"]);
const ADAPTER_RESULT_FIELDS = new Set(["text", "usage"]);
const USAGE_FIELDS = new Set(["inputTokens", "outputTokens", "totalTokens"]);
const PASSIVE_OUTPUT_ITEM_TYPES = new Set(["reasoning"]);
const ACTION_FIELDS = new Set([
  "actions", "arguments", "call_id", "computer_call", "function_call",
  "required_action", "shell_call", "tool_calls"
]);
const ACTION_TYPE_PART = /(?:^|_)(?:action|browser|call|code|command|computer|delete|exec|file|mcp|patch|search|shell|tool|url|web|write)(?:_|$)/;

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

function providerMessages(question, context) {
  const messages = [
    { role: "user", content: [{ type: "input_text", text: question }] }
  ];
  if (context) messages.push({ role: "user", content: [{ type: "input_text", text: context }] });
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
  if (payload.usage === undefined || payload.usage === null) {
    return Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null });
  }
  if (typeof payload.usage !== "object" || Array.isArray(payload.usage)) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider usage metadata is invalid.", {
      safeDetails: { reason: "usage_metadata_invalid" }
    });
  }
  return Object.freeze({
    inputTokens: numericUsage(payload.usage.input_tokens, "usage.input_tokens"),
    outputTokens: numericUsage(payload.usage.output_tokens, "usage.output_tokens"),
    totalTokens: numericUsage(payload.usage.total_tokens, "usage.total_tokens")
  });
}

function containsActionFields(value) {
  return Object.keys(value).some((key) => ACTION_FIELDS.has(key));
}

function invalidProviderOutput(reason, message = "Provider response did not contain one plain-text message.") {
  throw new TextResponseError("PROVIDER_RESPONSE_INVALID", message, {
    safeDetails: { reason }
  });
}

function extractText(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !Array.isArray(payload.output) || payload.output.length === 0) {
    invalidProviderOutput("non_text_provider_output");
  }
  if (payload.status !== undefined && payload.status !== "completed") {
    invalidProviderOutput("provider_response_incomplete", "Provider response was not complete.");
  }
  for (const key of ["tool_calls", "function_call", "required_action", "actions"]) {
    const value = payload[key];
    const emptyArray = Array.isArray(value) && value.length === 0;
    if (value !== undefined && value !== null && !emptyArray) {
      invalidProviderOutput("action_structure_detected", "Provider response contained unsupported action structures.");
    }
  }

  const messages = [];
  for (const item of payload.output) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.type !== "string") {
      invalidProviderOutput("unknown_output_item", "Provider response contained an unknown output item.");
    }
    if (PASSIVE_OUTPUT_ITEM_TYPES.has(item.type)) {
      if (containsActionFields(item)) {
        invalidProviderOutput("action_structure_detected", "Provider response contained unsupported action structures.");
      }
      continue;
    }
    if (item.type === "message") {
      messages.push(item);
      continue;
    }
    const reason = ACTION_TYPE_PART.test(item.type) ? "action_structure_detected" : "unknown_output_item";
    invalidProviderOutput(reason, "Provider response contained an unsupported output item.");
  }
  if (messages.length > 1) {
    invalidProviderOutput("multiple_text_outputs", "Provider response contained multiple text messages.");
  }
  if (messages.length !== 1) {
    invalidProviderOutput("non_text_provider_output");
  }

  const message = messages[0];
  if (message.role !== "assistant"
    || !Array.isArray(message.content) || message.content.length !== 1) {
    invalidProviderOutput("non_text_provider_output");
  }
  if (message.status !== undefined && message.status !== "completed") {
    invalidProviderOutput("provider_response_incomplete", "Provider response message was not complete.");
  }
  const content = message.content[0];
  if (!content || typeof content !== "object" || Array.isArray(content)
    || content.type !== "output_text" || typeof content.text !== "string") {
    invalidProviderOutput("non_text_provider_output", "Provider response did not contain plain text.");
  }
  if (!content.text.trim()) {
    invalidProviderOutput("empty_provider_output", "Provider response text was empty.");
  }
  const allowedContentFields = new Set(["type", "text", "annotations", "logprobs"]);
  if (Object.keys(content).some((key) => !allowedContentFields.has(key))
    || (content.annotations !== undefined && (!Array.isArray(content.annotations) || content.annotations.length))
    || (content.logprobs !== undefined && content.logprobs !== null
      && (!Array.isArray(content.logprobs) || content.logprobs.length))) {
    invalidProviderOutput("action_structure_detected", "Provider response contained unsupported output structures.");
  }
  return content.text;
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
  return new TextResponseError("PROVIDER_UNAVAILABLE", "The text provider is unavailable.", {
    retryable: false,
    safeDetails: { reason: "provider_network_error" }
  });
}

export function createOpenAITextAdapter({ apiKey, model, fetchImpl = globalThis.fetch } = {}) {
  if (typeof apiKey !== "string" || !apiKey || typeof model !== "string" || !model || typeof fetchImpl !== "function") {
    throw new TextResponseError("PROVIDER_NOT_CONFIGURED", "The text provider is not configured.");
  }
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
        instructions: input.instructions,
        input: providerMessages(input.question, input.context),
        max_output_tokens: input.maxOutputTokens,
        store: false
      };
      try {
        const response = await fetchImpl(OPENAI_RESPONSES_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json"
          },
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

export const openAITextAdapterInternals = Object.freeze({
  endpoint: OPENAI_RESPONSES_ENDPOINT,
  extractText,
  extractUsage
});
