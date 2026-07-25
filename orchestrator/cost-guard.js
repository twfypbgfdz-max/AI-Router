import { TextResponseError } from "./text-response-error.js";

function costUsd(inputTokens, outputTokens, providerConfig) {
  return (
    (inputTokens * providerConfig.inputUsdPerMillionTokens)
    + (outputTokens * providerConfig.outputUsdPerMillionTokens)
  ) / 1_000_000;
}

function rounded(value) {
  return Math.round(value * 100_000_000) / 100_000_000;
}

export function assertWorstCaseCost(inputTokens, outputTokens, providerConfig) {
  const worstCaseCostUsd = rounded(costUsd(inputTokens, outputTokens, providerConfig));
  if (worstCaseCostUsd > providerConfig.maxCostUsd) {
    throw new TextResponseError("COST_LIMIT_EXCEEDED", "Worst-case provider cost exceeds the configured limit.", {
      safeDetails: { reason: "worst_case_cost_limit" }
    });
  }
  return worstCaseCostUsd;
}

export function calculateProviderCost(inputTokens, outputTokens, providerConfig) {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  return rounded(costUsd(inputTokens, outputTokens, providerConfig));
}
