import test from "node:test";
import assert from "node:assert/strict";
import { buildHealthStatus } from "../orchestrator/health.js";
import { buildDiagnostics } from "../orchestrator/diagnostics.js";
import { projectCockpitStatus } from "../orchestrator/cockpit-status.js";
import { providerRegistry } from "../orchestrator/provider-registry.js";

const adapterStatus = { mock: { state: "available" }, "codex-cli": { state: "available" } };
const okStorage = { runStoreAvailable: true, status: "ok" };
const okLogging = { present: true, sizeClass: "small", status: "ok" };

test("health exposes safe provider-layer counters and a bounded status list", () => {
  const health = buildHealthStatus({ snapshot: { serviceStatus: "ok" }, adapterStatus, storage: okStorage, logging: okLogging, providers: providerRegistry.status(), startedAt: Date.now() });
  for (const key of ["providerRegistryStatus", "providerCount", "enabledProviderCount", "simulatedProviderCount", "executableProviderCount", "providerStatuses"]) assert.ok(key in health, `missing ${key}`);
  assert.equal(health.executableProviderCount, 2);
  assert.ok(Array.isArray(health.providerStatuses));
  const serialized = JSON.stringify(health.providerStatuses);
  assert.equal(serialized.includes(".exe"), false);
  assert.equal(serialized.includes("modelId"), false);
});

test("diagnostics aggregates provider run data without raw content", () => {
  const history = { total: 3, runs: [
    { runId: "a", status: "succeeded", selectedProviderId: "claude-simulated", providerWorkflowProfile: "specialist_chain", providerCount: 3, realLocalAdapterUsed: false },
    { runId: "b", status: "succeeded", selectedProviderId: "mock-local", providerWorkflowProfile: "single_provider", providerCount: 1, realLocalAdapterUsed: false },
    { runId: "c", status: "succeeded", selectedProviderId: "codex-local-readonly", providerWorkflowProfile: "single_provider", providerCount: 1, realLocalAdapterUsed: true }
  ] };
  const diag = buildDiagnostics({ history, adapterStatus, storage: okStorage, logging: okLogging });
  assert.equal(diag.runsByProvider["claude-simulated"], 1);
  assert.equal(diag.simulatedProviderRunCount, 2);
  assert.equal(diag.localCodexReadOnlyRunCount, 1);
  assert.equal(diag.multiProviderWorkflowCount, 1);
  assert.equal(diag.mostCommonWorkflowProfile, "single_provider");
});

test("cockpit adds only the three provider-overview fields and keeps every existing field", () => {
  const status = projectCockpitStatus({ serviceStatus: "ok", adapterStatus, checkedAt: "2026-01-01T00:00:00.000Z", providerLayer: providerRegistry.status() });
  assert.equal(status.providerLayerStatus, "ok");
  assert.equal(typeof status.enabledProviderCount, "number");
  assert.equal(typeof status.simulatedProviderCount, "number");
  for (const key of ["reachable", "version", "routerVersion", "activeOrWaitingRuns", "updatedAt", "lastRunStatus"]) assert.ok(key in status);
});
