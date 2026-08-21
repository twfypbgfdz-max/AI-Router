// R4/R5 - Action Foundation / Action Resolution. The seam between R2's
// intent router and the action layer.
//
// R2 answers "is this an action request?". R4 deliberately did not go
// further: there was no free-text -> actionId mapping at all, only a
// structurally complete but unresolved request (actionId: null) that the
// registry's default-deny rule turned into ACTION_NOT_REGISTERED.
//
// R5 closes part of that gap, but strictly on the registry's terms: this
// bridge now asks action-resolver.js's resolveActionIntent() whether the
// question deterministically matches exactly one registered action. If, and
// only if, the resolver reports "resolved" does actionId/parameters get
// filled in - "ambiguous", "unresolved" and "invalid" all still produce the
// same honest, unresolved request R4 always did (actionId: null -> denied
// by the registry's own default-deny rule, with a real request id and a
// real audit entry, never a guess).
//
// There is still no model call here and no free-form slot filling - see
// action-resolver.js's own header for why that boundary is load-bearing.
import { ACTION_ORIGINS } from "./action-types.js";
import { actionRegistry } from "./action-registry.js";
import { resolveActionIntent } from "./action-resolver.js";

export function buildActionRequestFromIntent(classification, { origin = "jarvis-ask", question = "", registry = actionRegistry } = {}) {
  if (classification?.intent !== "action") return null;
  const resolution = resolveActionIntent(question, registry);
  const resolved = resolution.resolution === "resolved";
  return Object.freeze({
    actionId: resolved ? resolution.actionId : null,
    parameters: resolved ? resolution.params : null,
    origin: ACTION_ORIGINS.includes(origin) ? origin : "internal",
    approval: null,
    // Not part of the action-service.js envelope (submit() only reads the
    // fields above) - carried alongside for the caller to audit/respond
    // with, exactly like jarvis-console-proxy.js already keeps
    // classification.intent internal rather than relaying it verbatim.
    resolution
  });
}
