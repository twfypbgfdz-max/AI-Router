// R4 - Action Foundation. The seam between R2's intent router and the
// action layer.
//
// R2 answers "is this an action request?". It does not, and cannot, answer
// "which action, with which parameters?" - that is a separate, much harder
// problem, and R4 deliberately does not solve it. There is no free-text ->
// actionId mapping in this repository, by design: guessing that "Schick Max
// eine Mail" means email.send with some inferred recipient is precisely the
// step that turns a language model into an unreviewed command generator.
//
// So this bridge builds a *structurally complete but unresolved* action
// request: correct envelope, correct origin, actionId null. It then flows
// through exactly the same pipeline as any other request and is denied by
// the registry's default-deny rule with ACTION_NOT_REGISTERED - producing a
// real request id and a real audit entry rather than a special case.
//
// Resolving an intent to a concrete action (an explicit picker in the
// Jarvis UI, or a constrained slot filler over the registry's own enum
// values) is R5 work. Until then this function is the honest answer.
import { ACTION_ORIGINS } from "./action-types.js";

export function buildActionRequestFromIntent(classification, { origin = "jarvis-ask" } = {}) {
  if (classification?.intent !== "action") return null;
  return Object.freeze({
    actionId: null,
    parameters: null,
    origin: ACTION_ORIGINS.includes(origin) ? origin : "internal",
    approval: null
  });
}
