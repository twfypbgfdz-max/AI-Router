import { TextResponseError } from "../text-response-error.js";

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_PROVIDER_BODY_BYTES = 1_048_576;
const ADAPTER_INPUT_FIELDS = new Set(["instructions", "question", "context", "maxOutputTokens", "signal"]);
const ADAPTER_RESULT_FIELDS = new Set(["text", "usage"]);
const USAGE_FIELDS = new Set(["inputTokens", "outputTokens", "totalTokens"]);

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

function extractText(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.output) || payload.output.length !== 1) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response did not contain one plain-text message.", {
      safeDetails: { reason: "non_text_provider_output" }
    });
  }
  for (const key of ["tool_calls", "function_call", "required_action", "actions"]) {
    const value = payload[key];
    const emptyArray = Array.isArray(value) && value.length === 0;
    if (value !== undefined && value !== null && !emptyArray) {
      throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response contained unsupported action structures.", {
        safeDetails: { reason: "action_structure_detected" }
      });
    }
  }
  const message = payload.output[0];
  if (!message || typeof message !== "object" || Array.isArray(message)
    || message.type !== "message" || message.role !== "assistant"
    || !Array.isArray(message.content) || message.content.length !== 1) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response did not contain one plain-text message.", {
      safeDetails: { reason: "non_text_provider_output" }
    });
  }
  const content = message.content[0];
  if (!content || typeof content !== "object" || Array.isArray(content)
    || content.type !== "output_text" || typeof content.text !== "string") {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response did not contain plain text.", {
      safeDetails: { reason: "non_text_provider_output" }
    });
  }
  const allowedContentFields = new Set(["type", "text", "annotations", "logprobs"]);
  if (Object.keys(content).some((key) => !allowedContentFields.has(key))
    || (content.annotations !== undefined && (!Array.isArray(content.annotations) || content.annotations.length))
    || (content.logprobs !== undefined && content.logprobs !== null)) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response contained unsupported output structures.", {
      safeDetails: { reason: "action_structure_detected" }
    });
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
