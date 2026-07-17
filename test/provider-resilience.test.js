import test from "node:test";
import assert from "node:assert/strict";
import { createProviderRegistry, PROVIDER_DEFINITIONS, MODEL_DEFINITIONS } from "../orchestrator/provider-registry.js";
import { selectProvider } from "../orchestrator/provider-selection.js";
import { createRoutePlan } from "../orchestrator/routing-engine.js";

test("a corrupted registry still yields a safe mock fallback and a degraded status", () => {
  const corrupted = [{ providerId: null }, "not-an-object", { providerId: "claude-simulated", capabilities: ["file-write"] }, ...PROVIDER_DEFINITIONS.filter((p) => p.providerId === "mock-local")];
  const registry = createProviderRegistry({ providerDefs: corrupted });
  assert.equal(registry.isExecutable("mock-local"), true);
  assert.equal(registry.status().registryStatus, "degraded");
  const plan = selectProvider({ routePlan: createRoutePlan("Analysiere den Code"), registry });
  assert.equal(plan.selectedProviderId, "mock-local");
});

test("invalid model definitions are dropped without crashing", () => {
  const badModels = [{ modelId: "definitely-not-allowed", providerId: "mock-local" }, { nonsense: true }, ...MODEL_DEFINITIONS];
  const registry = createProviderRegistry({ modelDefs: badModels });
  assert.equal(registry.getModel("definitely-not-allowed"), null);
  assert.ok(registry.listModels().length >= 5);
});

const hasCode = (code) => (error) => error && error.code === code;

test("selection against an empty registry fails safely with a provider error", () => {
  const empty = createProviderRegistry({ providerDefs: [] });
  assert.throws(() => selectProvider({ routePlan: createRoutePlan("Analysiere den Code"), request: { requestedProvider: "claude-simulated" }, registry: empty }), hasCode("PROVIDER_NOT_FOUND"));
});

test("a missing route plan is a controlled selection failure, not a crash", () => {
  assert.throws(() => selectProvider({ routePlan: null }), hasCode("PROVIDER_SELECTION_FAILED"));
});
