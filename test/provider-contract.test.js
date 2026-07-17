import test from "node:test";
import assert from "node:assert/strict";
import { createProviderContract, isValidProviderContract, projectPublicProvider, PROVIDER_CONTRACT_FIELDS } from "../orchestrator/provider-contract.js";

function validRaw(overrides = {}) {
  return {
    providerId: "claude-simulated", displayName: "Claude-Profil (Simulation)", providerType: "claude",
    executionMode: "simulation", adapterId: "mock", modelId: "claude-general-sim",
    capabilities: ["planning", "analysis"], supportedTaskTypes: ["planning", "code"], supportedRoles: ["planner", "executor"],
    availability: "available", enabled: true, simulated: true, external: true,
    requiresNetwork: false, requiresCredentials: false,
    riskClass: "low", priority: 80, costClass: "medium", latencyClass: "medium", contextClass: "high", outputClass: "high",
    safeMetadata: { focus: "planning" },
    ...overrides
  };
}

test("a valid provider contract is accepted, frozen and carries only allowlisted fields", () => {
  const contract = createProviderContract(validRaw());
  assert.equal(contract.providerId, "claude-simulated");
  assert.equal(Object.isFrozen(contract), true);
  for (const key of Object.keys(contract)) assert.ok([...PROVIDER_CONTRACT_FIELDS, "executable"].includes(key), `unexpected field ${key}`);
  assert.throws(() => { contract.enabled = false; }, /Cannot assign|read only/i);
});

test("unknown fields are never forwarded into the contract", () => {
  const contract = createProviderContract(validRaw({ secretApiKey: "sk-should-not-appear", evil: true }));
  assert.equal("secretApiKey" in contract, false);
  assert.equal("evil" in contract, false);
  assert.equal(JSON.stringify(contract).includes("sk-should-not-appear"), false);
});

test("an invalid providerId is rejected", () => {
  assert.throws(() => createProviderContract(validRaw({ providerId: "totally-custom-provider" })), /PROVIDER_CONFIGURATION_INVALID|allowlist/);
  assert.equal(isValidProviderContract(validRaw({ providerId: "x" })), false);
});

test("an invalid adapterId is rejected", () => {
  assert.throws(() => createProviderContract(validRaw({ adapterId: "shell" })));
});

test("an unsupported role is rejected", () => {
  assert.throws(() => createProviderContract(validRaw({ supportedRoles: ["hacker"] })));
});

test("an unknown or forbidden capability is rejected", () => {
  assert.throws(() => createProviderContract(validRaw({ capabilities: ["mind-reading"] })));
  assert.throws(() => createProviderContract(validRaw({ capabilities: ["file-write"] })));
  assert.throws(() => createProviderContract(validRaw({ capabilities: ["deployment"] })));
});

test("network or credential requirements are rejected outright", () => {
  assert.throws(() => createProviderContract(validRaw({ requiresNetwork: true })));
  assert.throws(() => createProviderContract(validRaw({ requiresCredentials: true })));
});

test("a simulated provider may not bind to the real read-only codex adapter", () => {
  assert.throws(() => createProviderContract(validRaw({ providerId: "claude-simulated", adapterId: "codex-cli-readonly", executionMode: "simulation" })));
});

test("safeMetadata is strongly bounded and drops non-primitive values", () => {
  const contract = createProviderContract(validRaw({ safeMetadata: { a: "1", b: 2, c: true, d: { nested: 1 }, e: [1, 2], f: () => {}, g: "x".repeat(500) } }));
  assert.equal(Object.keys(contract.safeMetadata).length <= 8, true);
  assert.equal("d" in contract.safeMetadata, false);
  assert.equal("e" in contract.safeMetadata, false);
  assert.equal("f" in contract.safeMetadata, false);
  assert.ok(contract.safeMetadata.g.length <= 80);
});

test("the public projection exposes only safe fields", () => {
  const pub = projectPublicProvider(createProviderContract(validRaw()));
  assert.deepEqual(Object.keys(pub).sort(), ["capabilities", "costClass", "displayName", "enabled", "executable", "external", "latencyClass", "providerId", "providerType", "riskClass", "simulated", "status", "supportedRoles", "supportedTaskTypes"].sort());
  assert.equal(JSON.stringify(pub).includes("safeMetadata"), false);
});
