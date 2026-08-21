// R5 - Action Resolution. Deterministic, registry-anchored mapping from an
// action-intent question to a concrete, registered action plus validated
// parameters.
//
// Strictly registry-based, per the R5 spec: this module never invents an
// action id and never accepts a parameter value the registry itself does
// not already permit. It works in two layers -
//   1. a small, hand-maintained alias table (verb -> actionId, free text ->
//      enum value) that only *proposes* a candidate;
//   2. the registry's own resolve()/validateActionParameters(), which is
//      the sole authority on whether that candidate actually exists and is
//      well-formed.
// A candidate that fails step 2 (e.g. the caller passed a registry that
// does not have this action, such as a test fixture) is silently dropped,
// never reported as resolved - the registry can only narrow what the
// resolver returns, never be bypassed by it.
//
// No model call. No free-form slot filling. If a model is ever wired in
// ahead of this module, its output must be treated as exactly one more
// unverified candidate and pushed through the same registry/parameter
// validation this file already performs - never trusted directly.
import { validateActionParameters } from "./action-registry.js";

// Verb aliases per action id. Narrow and hand-maintained on purpose -
// broadening this table is a deliberate registry-adjacent decision, not
// something a caller or a model can extend at runtime.
const ACTION_VERB_ALIASES = Object.freeze({
  "app.open": Object.freeze(["öffne", "öffnen", "starte", "starten", "start"]),
  "jarvis.action.list": Object.freeze(["liste die aktionen", "zeig die aktionen", "zeige die aktionen", "welche aktionen", "verfügbare aktionen"])
});

// Free-text -> enum value aliases, keyed by action id and parameter name.
// Every alias group's key MUST be one of that parameter's own registered
// enum values - enforced by resolveActionIntent() below via
// validateActionParameters(), not just by convention.
const ACTION_PARAMETER_ALIASES = Object.freeze({
  "app.open": Object.freeze({
    target: Object.freeze({
      spotify: Object.freeze(["spotify"])
    })
  })
});

function normalize(question) {
  return question
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[.,!?;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsToken(haystack, needle) {
  // Unicode-aware word boundary, same reasoning as intent-rules.js's
  // ACTION_VERB_PATTERN: plain \b does not fire correctly before/after an
  // umlaut, so a manual lookaround over \p{L}/\p{N} is used instead. needle
  // may itself be a multi-word phrase (e.g. "liste die aktionen"), so the
  // boundary is only checked at its two outer edges.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u");
  return pattern.test(haystack);
}

function matchedVerbActionIds(normalizedQuestion) {
  const matched = [];
  for (const [actionId, aliases] of Object.entries(ACTION_VERB_ALIASES)) {
    if (aliases.some((alias) => containsToken(normalizedQuestion, alias))) matched.push(actionId);
  }
  return matched;
}

// For one action id, determine its parameter candidates from the question.
// Returns:
//   { outcome: "none-required" }                     - no parameters needed
//   { outcome: "matched", parameters }                - exactly one combination found
//   { outcome: "not-found" }                          - parameters required, none matched
//   { outcome: "ambiguous" }                          - more than one distinct value matched
function resolveParametersForAction(actionId, normalizedQuestion) {
  const parameterAliases = ACTION_PARAMETER_ALIASES[actionId];
  if (!parameterAliases || Object.keys(parameterAliases).length === 0) return { outcome: "none-required" };

  const parameters = {};
  for (const [paramName, valueGroups] of Object.entries(parameterAliases)) {
    const matchedValues = Object.entries(valueGroups)
      .filter(([, aliases]) => aliases.some((alias) => containsToken(normalizedQuestion, alias)))
      .map(([value]) => value);
    if (matchedValues.length > 1) return { outcome: "ambiguous" };
    if (matchedValues.length === 0) return { outcome: "not-found" };
    parameters[paramName] = matchedValues[0];
  }
  return { outcome: "matched", parameters };
}

function candidate(actionId, parameters) {
  return Object.freeze({ actionId, parameters: Object.freeze({ ...parameters }) });
}

// The single entry point. Always returns one of exactly four resolutions -
// never throws for an ordinary unmatched or ambiguous question, mirroring
// classifyIntent()'s "always resolves" posture elsewhere in this codebase.
//
//   { resolution: "resolved",   actionId, params, confidence: "exact" }
//   { resolution: "ambiguous",  candidates: [{ actionId, parameters }] }
//   { resolution: "unresolved" }
//   { resolution: "invalid" }   - question was not a usable string at all
export function resolveActionIntent(question, registry) {
  if (typeof question !== "string" || !question.trim()) return Object.freeze({ resolution: "invalid" });
  if (!registry || typeof registry.has !== "function" || typeof registry.resolve !== "function") {
    return Object.freeze({ resolution: "invalid" });
  }

  const normalizedQuestion = normalize(question);
  const verbMatchedActionIds = matchedVerbActionIds(normalizedQuestion).filter((actionId) => registry.has(actionId));
  if (verbMatchedActionIds.length === 0) return Object.freeze({ resolution: "unresolved" });

  const resolvedCandidates = [];
  let sawAmbiguousParameters = false;

  for (const actionId of verbMatchedActionIds) {
    const parameterResult = resolveParametersForAction(actionId, normalizedQuestion);
    if (parameterResult.outcome === "ambiguous") {
      sawAmbiguousParameters = true;
      continue;
    }
    if (parameterResult.outcome === "not-found") continue; // verb matched, target did not - never guessed
    const parameters = parameterResult.outcome === "matched" ? parameterResult.parameters : {};

    // Final authority: the registry itself. A candidate that the registry
    // rejects (wrong action, invalid/unknown parameter) is dropped, not
    // reported - the alias tables above can only propose, never override
    // the registry's own resolve()/validateActionParameters().
    let definition;
    try {
      definition = registry.resolve(actionId);
    } catch {
      continue;
    }
    try {
      const validated = validateActionParameters(definition, parameters);
      resolvedCandidates.push(candidate(actionId, validated));
    } catch {
      continue;
    }
  }

  if (resolvedCandidates.length > 1) {
    return Object.freeze({ resolution: "ambiguous", candidates: resolvedCandidates });
  }
  if (resolvedCandidates.length === 1) {
    const [only] = resolvedCandidates;
    return Object.freeze({ resolution: "resolved", actionId: only.actionId, params: only.parameters, confidence: "exact" });
  }
  if (sawAmbiguousParameters) return Object.freeze({ resolution: "ambiguous", candidates: [] });
  return Object.freeze({ resolution: "unresolved" });
}
