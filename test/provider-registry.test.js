import test from "node:test";
import assert from "node:assert/strict";
import { createProviderRegistry, providerRegistry, PROVIDER_DEFINITIONS } from "../orchestrator/provider-registry.js";

test("every production registry entry is valid and there are no duplicate ids", () => {
  const status = providerRegistry.status();
  assert.equal(status.registryStatus, "ok");
  assert.equal(status.invalidProviderCount, 0);
  const ids = providerRegistry.list().map((p) => p.providerId);
  assert.equal(new Set(ids).size, ids.length);
});

test("only mock-local and codex-local-readonly are executable; the rest are simulated", () => {
  const executable = providerRegistry.list().filter((p) => p.executable).map((p) => p.providerId).sort();
  assert.deepEqual(executable, ["codex-local-readonly", "mock-local"]);
  assert.equal(providerRegistry.get("claude-simulated").simulated, true);
  assert.equal(providerRegistry.get("openai-simulated").simulated, true);
  assert.equal(providerRegistry.get("gemini-simulated").simulated, true);
});

test("codex-local-readonly is a real read-only provider, not a simulation", () => {
  const codex = providerRegistry.get("codex-local-readonly");
  assert.equal(codex.simulated, false);
  assert.equal(codex.executionMode, "local-read-only");
  assert.equal(codex.adapterId, "codex-cli-readonly");
});

test("mock stays available as the safe fallback even when another entry is invalid", () => {
  const broken = [...PROVIDER_DEFINITIONS, { providerId: "openai-simulated", adapterId: "shell", providerType: "openai" }];
  const registry = createProviderRegistry({ providerDefs: broken });
  assert.equal(registry.isExecutable("mock-local"), true);
  assert.equal(registry.status().registryStatus, "degraded");
  assert.ok(registry.status().invalidProviderCount >= 1);
  // A disallowed/invalid entry never becomes a real executable adapter.
  assert.equal(registry.isExecutable("openai-simulated"), false);
});

test("registry status exposes only safe counts and a bounded provider status list", () => {
  const status = providerRegistry.status();
  for (const key of ["registryStatus", "providerCount", "enabledProviderCount", "simulatedProviderCount", "executableProviderCount", "invalidProviderCount", "providerStatuses"]) assert.ok(key in status);
  for (const entry of status.providerStatuses) {
    assert.deepEqual(Object.keys(entry).sort(), ["checkedAt", "executable", "providerId", "simulated", "status"].sort());
  }
  assert.equal(JSON.stringify(status).includes(".exe"), false);
  assert.equal(JSON.stringify(status).includes("C:\\"), false);
});

test("model profiles are validated and carry only safe metadata", () => {
  const models = providerRegistry.listModels();
  assert.ok(models.length >= 5);
  for (const model of models) {
    assert.equal(typeof model.modelId, "string");
    assert.equal(typeof model.deterministicSimulationProfile, "string");
    assert.equal(JSON.stringify(model).includes("price"), false);
    assert.equal(JSON.stringify(model).includes("token"), false);
  }
});
