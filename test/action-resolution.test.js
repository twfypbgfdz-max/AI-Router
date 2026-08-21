import test from "node:test";
import assert from "node:assert/strict";
import { resolveActionIntent } from "../orchestrator/action/action-resolver.js";
import { buildActionRequestFromIntent } from "../orchestrator/action/action-intent-bridge.js";
import { actionRegistry, createActionRegistry } from "../orchestrator/action/action-registry.js";

// --- resolver: exact, alias, unknown target, ambiguous, invalid -----------

test("an unambiguous, allowed request resolves to the known action", () => {
  const result = resolveActionIntent("Öffne Spotify.", actionRegistry);
  assert.equal(result.resolution, "resolved");
  assert.equal(result.actionId, "app.open");
  assert.deepEqual(result.params, { target: "spotify" });
  assert.equal(result.confidence, "exact");
});

test("an allowed verb alias resolves to the same known action", () => {
  const result = resolveActionIntent("Starte Spotify.", actionRegistry);
  assert.equal(result.resolution, "resolved");
  assert.equal(result.actionId, "app.open");
  assert.deepEqual(result.params, { target: "spotify" });
});

test("R6: an unambiguous request for obsidian resolves to the known action", () => {
  const result = resolveActionIntent("Öffne Obsidian.", actionRegistry);
  assert.equal(result.resolution, "resolved");
  assert.equal(result.actionId, "app.open");
  assert.deepEqual(result.params, { target: "obsidian" });
});

test("an unknown app name is unresolved, never guessed", () => {
  const result = resolveActionIntent("Öffne Notepad.", actionRegistry);
  assert.equal(result.resolution, "unresolved");
  assert.equal(result.actionId, undefined);
});

test("a completely unrelated action-shaped question is unresolved", () => {
  assert.equal(resolveActionIntent("Lösch das.", actionRegistry).resolution, "unresolved");
  assert.equal(resolveActionIntent("Öffne das.", actionRegistry).resolution, "unresolved");
});

test("a question matching two distinct actions is reported ambiguous, not guessed", () => {
  const result = resolveActionIntent("Öffne Spotify, und welche Aktionen gibt es sonst noch?", actionRegistry);
  assert.equal(result.resolution, "ambiguous");
  const ids = result.candidates.map((c) => c.actionId).sort();
  assert.deepEqual(ids, ["app.open", "jarvis.action.list"]);
});

test("a non-string or empty question is invalid, not unresolved", () => {
  for (const question of [undefined, null, 42, {}, "", "   "]) {
    assert.equal(resolveActionIntent(question, actionRegistry).resolution, "invalid");
  }
});

test("an invalid or missing registry is invalid, never crashes", () => {
  assert.equal(resolveActionIntent("Öffne Spotify.", null).resolution, "invalid");
  assert.equal(resolveActionIntent("Öffne Spotify.", {}).resolution, "invalid");
});

// --- resolver is strictly registry-anchored --------------------------------

test("a fixture registry without app.open never resolves an open-Spotify question", () => {
  const fixture = createActionRegistry([
    { id: "app.test.gated", description: "d", risk: "medium", requiresApproval: true, parameters: { target: { type: "enum", required: true, values: ["spotify"] } }, executor: null }
  ]);
  const result = resolveActionIntent("Öffne Spotify.", fixture);
  assert.equal(result.resolution, "unresolved", "the resolver must never invent app.open when the registry does not have it");
});

test("a registry whose app.open definition dropped the target parameter never yields an invalid candidate", () => {
  // Same action id and verb-matching alias, but a parameter shape the
  // resolver's own alias table does not anticipate - the candidate must be
  // dropped by validateActionParameters, not force-fit.
  const fixture = createActionRegistry([
    { id: "app.open", description: "d", risk: "medium", requiresApproval: true, parameters: { app: { type: "enum", required: true, values: ["spotify"] } }, executor: null }
  ]);
  const result = resolveActionIntent("Öffne Spotify.", fixture);
  assert.equal(result.resolution, "unresolved");
});

test("resolveActionIntent never returns an actionId the registry does not have", () => {
  const fixture = createActionRegistry([]);
  const result = resolveActionIntent("Öffne Spotify. Starte Spotify. Welche Aktionen gibt es?", fixture);
  assert.equal(result.resolution, "unresolved");
});

// --- R2 -> R5 bridge --------------------------------------------------------

test("the bridge resolves an action intent to a concrete, registry-validated request", () => {
  const built = buildActionRequestFromIntent({ intent: "action" }, { question: "Öffne Spotify.", registry: actionRegistry });
  assert.equal(built.actionId, "app.open");
  assert.deepEqual(built.parameters, { target: "spotify" });
  assert.equal(built.resolution.resolution, "resolved");
});

test("the bridge still returns an unresolved request for an ambiguous or unresolved question", () => {
  const ambiguous = buildActionRequestFromIntent({ intent: "action" }, { question: "Öffne Spotify, und welche Aktionen gibt es sonst noch?", registry: actionRegistry });
  assert.equal(ambiguous.actionId, null);
  assert.equal(ambiguous.resolution.resolution, "ambiguous");

  const unresolved = buildActionRequestFromIntent({ intent: "action" }, { question: "Öffne Notepad.", registry: actionRegistry });
  assert.equal(unresolved.actionId, null);
  assert.equal(unresolved.resolution.resolution, "unresolved");
});

test("a knowledge intent never reaches the resolver at all", () => {
  assert.equal(buildActionRequestFromIntent({ intent: "knowledge" }, { question: "Öffne Spotify." }), null);
  assert.equal(buildActionRequestFromIntent({ intent: "operational" }, { question: "Öffne Spotify." }), null);
});
