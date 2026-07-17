import test from "node:test";
import assert from "node:assert/strict";
import { createRoutePlan } from "../orchestrator/routing-engine.js";
import { selectProvider, previewProviderSelection } from "../orchestrator/provider-selection.js";

const plan = (task) => createRoutePlan(task);

test("automatic selection is deterministic and defaults to the safe mock simulation", () => {
  const a = selectProvider({ routePlan: plan("Analysiere den Code im Repository") });
  const b = selectProvider({ routePlan: plan("Analysiere den Code im Repository") });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.equal(a.selectedProviderId, "mock-local");
  assert.equal(a.selectionMode, "automatic");
  assert.equal(a.simulated, true);
  assert.ok(a.alternatives.length >= 1);
});

test("a manual, allowed, matching provider is selected with high confidence", () => {
  const p = selectProvider({ routePlan: plan("Erstelle ein Konzept"), request: { requestedProvider: "claude-simulated" } });
  assert.equal(p.selectedProviderId, "claude-simulated");
  assert.equal(p.selectionMode, "manual");
  assert.equal(p.confidence, "high");
  assert.equal(p.capabilityMatch, true);
});

const hasCode = (code) => (error) => error && error.code === code;

test("a manual unknown provider name is rejected at the contract, not silently run", () => {
  assert.throws(() => previewProviderSelection({ taskType: "code", requestedProvider: "claude-3-opus-real" }), hasCode("PROVIDER_NOT_ALLOWED"));
});

test("a capability, role or task mismatch is a controlled error, never a silent execution", () => {
  assert.throws(() => selectProvider({ routePlan: plan("Analysiere den Code"), request: { requestedProvider: "claude-simulated" } }), hasCode("PROVIDER_CAPABILITY_MISMATCH"));
  assert.throws(() => selectProvider({ routePlan: plan("Plane mein Budget und meine Finanzen"), request: { requestedProvider: "codex-local-readonly" } }), hasCode("PROVIDER_TASK_NOT_SUPPORTED"));
});

test("provider selection never bypasses the approval gate", () => {
  const p = selectProvider({ routePlan: plan("Bitte lösche die Datei config.json"), request: { requestedProvider: "claude-simulated" } });
  assert.equal(p.selectedProviderId, "mock-local");
  assert.equal(p.providerWorkflowProfile, "single_provider");
  assert.ok(p.warnings.some((w) => /Freigabe/i.test(w)));
});

test("specialist_chain assigns different simulated providers per role with a safe fallback", () => {
  const p = selectProvider({ routePlan: plan("Analysiere den Code im Repository vollstaendig und systematisch"), request: { options: { providerProfile: "specialist_chain" } } });
  assert.equal(p.providerWorkflowProfile, "specialist_chain");
  const byRole = Object.fromEntries(p.roleAssignments.map((a) => [a.role, a.providerId]));
  assert.equal(byRole.planner, "claude-simulated");
  assert.equal(byRole.executor, "openai-simulated");
  assert.equal(byRole.synthesizer, "mock-local");
  assert.ok(p.roleAssignments.every((a) => a.simulated === true));
});

test("safe_review_chain keeps execution on the safe mock provider, review on a simulated reviewer", () => {
  const p = selectProvider({ routePlan: plan("Analysiere den Code im Repository vollstaendig und systematisch"), request: { options: { providerProfile: "safe_review_chain" } } });
  const byRole = Object.fromEntries(p.roleAssignments.map((a) => [a.role, a.providerId]));
  assert.equal(byRole.executor, "mock-local");
  assert.equal(byRole.reviewer, "claude-simulated");
});

test("the preview endpoint helper works from bounded classifier inputs without task text", () => {
  const p = previewProviderSelection({ taskType: "planning", complexity: "medium", riskLevel: "R0", requestedProvider: "claude-simulated" });
  assert.equal(p.selectedProviderId, "claude-simulated");
  const disabled = previewProviderSelection({ taskType: "planning", riskLevel: "R4" });
  assert.equal(disabled.selectedProviderId, "mock-local");
});
