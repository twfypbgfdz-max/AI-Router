import { TextResponseError } from "./text-response-error.js";

// The provider-adapter interface every text-generation provider adapter must
// implement (see provider-adapters/openai-text.js and provider-adapters/ollama-text.js).
//
// generateText(input) -> Promise<{ text: string, usage: TextProviderUsage }>
//
// input:  { instructions: string, question: string, context: string|null,
//           maxOutputTokens: number, signal: AbortSignal }
// usage:  { inputTokens: number|null, outputTokens: number|null, totalTokens: number|null }
//
// Adapters must throw TextResponseError (using the PROVIDER_* codes from
// text-response-response.js) instead of raw errors, so callers can react the
// same way regardless of which provider is behind the adapter. This module
// only describes and validates the shape of an adapter — it does not select
// or route between providers, so it can be extended with new adapters (e.g.
// a future Anthropic adapter) without touching the router core.
export const TEXT_PROVIDER_ADAPTER_INPUT_FIELDS = Object.freeze([
  "instructions", "question", "context", "maxOutputTokens", "signal"
]);
export const TEXT_PROVIDER_ADAPTER_RESULT_FIELDS = Object.freeze(["text", "usage"]);
export const TEXT_PROVIDER_ADAPTER_USAGE_FIELDS = Object.freeze(["inputTokens", "outputTokens", "totalTokens"]);

// Non-throwing structural check: does this look like a text-provider adapter
// factory result? Used by callers that accept a pluggable adapter instance.
export function isTextProviderAdapter(adapter) {
  return Boolean(adapter) && typeof adapter.generateText === "function";
}

export function assertTextProviderAdapter(adapter) {
  if (!isTextProviderAdapter(adapter)) {
    throw new TextResponseError("INTERNAL_ERROR", "Provider adapter does not implement the text-provider interface.");
  }
  return adapter;
}
