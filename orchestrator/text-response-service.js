import { classifyTask } from "./task-classifier.js";
import { normalizeTextResponseRequest } from "./text-response-contract.js";
import {
  TEXT_RESPONSE_MAX_INPUT_TOKENS,
  TEXT_RESPONSE_MAX_OUTPUT_CHARS,
  TEXT_RESPONSE_MAX_OUTPUT_TOKENS,
  TEXT_RESPONSE_MAX_TOTAL_TOKENS,
  TEXT_RESPONSE_PROVIDER_ID
} from "./text-response-config.js";
import { loadOpenAITextProviderConfig } from "./text-response-config.js";
import { assertProviderInputBudget, estimateTextTokens } from "./context-limiter.js";
import { assertWorstCaseCost, calculateProviderCost } from "./cost-guard.js";
import { assertProviderEgressAllowed } from "./provider-egress-policy.js";
import { createOpenAITextAdapter } from "./provider-adapters/openai-text.js";
import { TextResponseError } from "./text-response-error.js";
import { buildTextResponsePrompt } from "./text-response-prompt.js";

const SAFE_ROUTES = new Set(["analysis", "content_generation", "general_chat", "knowledge_query", "planning"]);
const ADAPTER_RESULT_FIELDS = new Set(["text", "usage"]);
const USAGE_FIELDS = new Set(["inputTokens", "outputTokens", "totalTokens"]);

function routeName(taskType, intent) {
  if (["writing", "social_media", "career"].includes(taskType) || intent === "content_generation" || intent === "writing") return "content_generation";
  if (taskType === "planning" || intent === "planning") return "planning";
  if (["code", "research", "finance"].includes(taskType) || ["analysis", "code_analysis"].includes(intent)) return "analysis";
  if (["learning", "obsidian"].includes(taskType) || ["general_question", "explanation", "project_status_summary"].includes(intent)) return "knowledge_query";
  return "general_chat";
}

function exactObject(value, fields, reason) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.has(key))) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response is invalid.", {
      safeDetails: { reason }
    });
  }
}

function usageNumber(value, field) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider usage metadata is invalid.", {
      safeDetails: { reason: "usage_metadata_invalid", field }
    });
  }
  return value;
}

function validatedAdapterResult(value, inputTokenEstimate) {
  exactObject(value, ADAPTER_RESULT_FIELDS, "adapter_result_shape");
  exactObject(value.usage, USAGE_FIELDS, "usage_metadata_invalid");
  if (typeof value.text !== "string") {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response did not contain text.", {
      safeDetails: { reason: "non_text_provider_output" }
    });
  }
  const text = value.text.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
  if (!text) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response text is empty.", {
      safeDetails: { reason: "empty_provider_output" }
    });
  }
  if (text.length > TEXT_RESPONSE_MAX_OUTPUT_CHARS || estimateTextTokens(text) > TEXT_RESPONSE_MAX_OUTPUT_TOKENS) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response exceeds its output limit.", {
      safeDetails: { reason: "output_limit_exceeded", limit: TEXT_RESPONSE_MAX_OUTPUT_CHARS }
    });
  }
  if (/<(?:!doctype|html|script|style|iframe|object|embed|form|body|head|a|img|div|span|p|br)\b[^>]*>/i.test(text)) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response contains HTML.", {
      safeDetails: { reason: "html_output_blocked" }
    });
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider response contains unsupported control characters.", {
      safeDetails: { reason: "control_characters_blocked" }
    });
  }
  const usage = Object.freeze({
    inputTokens: usageNumber(value.usage.inputTokens, "usage.inputTokens"),
    outputTokens: usageNumber(value.usage.outputTokens, "usage.outputTokens"),
    totalTokens: usageNumber(value.usage.totalTokens, "usage.totalTokens")
  });
  if ((usage.inputTokens !== null && usage.inputTokens > TEXT_RESPONSE_MAX_INPUT_TOKENS)
    || (usage.outputTokens !== null && usage.outputTokens > TEXT_RESPONSE_MAX_OUTPUT_TOKENS)
    || (usage.totalTokens !== null && usage.totalTokens > TEXT_RESPONSE_MAX_TOTAL_TOKENS)) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Provider usage exceeded the configured token budget.", {
      safeDetails: { reason: "provider_usage_limit_exceeded" }
    });
  }
  return Object.freeze({
    text,
    usage,
    billedInputTokens: usage.inputTokens ?? inputTokenEstimate,
    billedOutputTokens: usage.outputTokens ?? estimateTextTokens(text)
  });
}

function abortError(signal, fallbackReason) {
  if (signal?.reason instanceof TextResponseError) return signal.reason;
  return new TextResponseError("PROVIDER_TIMEOUT", "Provider request was aborted.", {
    safeDetails: { reason: fallbackReason }
  });
}

export function createTextResponseService({
  env = process.env,
  adapterFactory = createOpenAITextAdapter,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  return Object.freeze({
    async respond(rawInput, { signal } = {}) {
      if (!signal || typeof signal.addEventListener !== "function") {
        throw new TextResponseError("INTERNAL_ERROR", "A request abort signal is required.");
      }
      if (signal.aborted) throw abortError(signal, "request_aborted");
      const request = normalizeTextResponseRequest(rawInput, { now });
      assertProviderEgressAllowed(request);
      const taskType = classifyTask(request.input.content);
      const route = routeName(taskType, request.intent);
      if (!SAFE_ROUTES.has(route)) {
        throw new TextResponseError("NO_SAFE_ROUTE", "No safe text route is available.", {
          safeDetails: { reason: "no_safe_route" }
        });
      }

      const prompt = buildTextResponsePrompt(request);
      const inputTokenEstimate = assertProviderInputBudget({
        ...prompt,
        maxOutputTokens: TEXT_RESPONSE_MAX_OUTPUT_TOKENS
      });
      const providerConfig = loadOpenAITextProviderConfig(env);
      const worstCaseCostUsd = assertWorstCaseCost(
        inputTokenEstimate,
        TEXT_RESPONSE_MAX_OUTPUT_TOKENS,
        providerConfig
      );
      const adapter = adapterFactory(providerConfig);
      if (!adapter || typeof adapter.generateText !== "function") {
        throw new TextResponseError("INTERNAL_ERROR", "The text provider adapter is unavailable.");
      }

      const providerController = new AbortController();
      const onRequestAbort = () => providerController.abort(abortError(signal, "request_aborted"));
      signal.addEventListener("abort", onRequestAbort, { once: true });
      const timer = setTimer(() => {
        providerController.abort(new TextResponseError("PROVIDER_TIMEOUT", "The text provider timed out.", {
          safeDetails: { reason: "provider_timeout" }
        }));
      }, providerConfig.timeoutMs);
      let rawResult;
      try {
        const providerOperation = Promise.resolve(adapter.generateText({
          instructions: prompt.instructions,
          question: prompt.question,
          context: prompt.context,
          maxOutputTokens: TEXT_RESPONSE_MAX_OUTPUT_TOKENS,
          signal: providerController.signal
        }));
        const aborted = new Promise((resolve, reject) => {
          const onAbort = () => reject(abortError(providerController.signal, "provider_aborted"));
          providerController.signal.addEventListener("abort", onAbort, { once: true });
          providerOperation.finally(() => providerController.signal.removeEventListener("abort", onAbort)).catch(() => {});
        });
        rawResult = await Promise.race([providerOperation, aborted]);
      } catch (error) {
        if (providerController.signal.aborted) throw abortError(providerController.signal, "provider_aborted");
        if (error instanceof TextResponseError) throw error;
        throw new TextResponseError("PROVIDER_UNAVAILABLE", "The text provider is unavailable.", {
          safeDetails: { reason: "provider_error" }
        });
      } finally {
        clearTimer(timer);
        signal.removeEventListener("abort", onRequestAbort);
      }

      const result = validatedAdapterResult(rawResult, inputTokenEstimate);
      const calculatedCostUsd = calculateProviderCost(
        result.billedInputTokens,
        result.billedOutputTokens,
        providerConfig
      );
      return Object.freeze({
        request,
        route: Object.freeze({ name: route, taskType }),
        answerText: result.text,
        provider: Object.freeze({
          providerId: TEXT_RESPONSE_PROVIDER_ID,
          model: providerConfig.publicModel,
          modelAlias: providerConfig.modelAlias
        }),
        usage: result.usage,
        inputTokenEstimate,
        worstCaseCostUsd,
        calculatedCostUsd
      });
    }
  });
}

export const textResponseServiceInternals = Object.freeze({
  routeName,
  validatedAdapterResult
});
