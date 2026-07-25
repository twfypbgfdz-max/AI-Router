import {
  TEXT_RESPONSE_MAX_INPUT_TOKENS,
  TEXT_RESPONSE_MAX_TOTAL_TOKENS
} from "./text-response-config.js";
import { TextResponseError } from "./text-response-error.js";

export function estimateTextTokens(value) {
  if (!value) return 0;
  return Math.ceil(Buffer.byteLength(String(value), "utf8") / 3);
}

export function estimateProviderInputTokens({ instructions, question, context }) {
  const messageOverhead = context ? 36 : 24;
  return estimateTextTokens(instructions)
    + estimateTextTokens(question)
    + estimateTextTokens(context)
    + messageOverhead;
}

export function assertProviderInputBudget({ instructions, question, context, maxOutputTokens }) {
  const inputTokenEstimate = estimateProviderInputTokens({ instructions, question, context });
  if (inputTokenEstimate > TEXT_RESPONSE_MAX_INPUT_TOKENS) {
    throw new TextResponseError("TOKEN_LIMIT_EXCEEDED", "Estimated input tokens exceed the configured limit.", {
      safeDetails: { reason: "input_token_limit", limit: TEXT_RESPONSE_MAX_INPUT_TOKENS }
    });
  }
  if (inputTokenEstimate + maxOutputTokens > TEXT_RESPONSE_MAX_TOTAL_TOKENS) {
    throw new TextResponseError("TOKEN_LIMIT_EXCEEDED", "Estimated total tokens exceed the configured limit.", {
      safeDetails: { reason: "total_token_limit", limit: TEXT_RESPONSE_MAX_TOTAL_TOKENS }
    });
  }
  return inputTokenEstimate;
}
