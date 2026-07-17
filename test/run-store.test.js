import test from "node:test";
import assert from "node:assert/strict";
import { projectCockpitStatus } from "../orchestrator/cockpit-status.js";
import { createRunStore } from "../orchestrator/run-store.js";

test("cockpit status is a stable read-only contract without task or approval content", () => {
  const status = projectCockpitStatus({ serviceStatus: "ok", activeRuns: 2, awaitingApprovalRuns: 1, lastSuccessfulRunAt: "2026-01-01T00:00:00.000Z", lastSafeErrorCode: "ADAPTER_FAILED", adapterStatus: { mock: { state: "available" }, "codex-cli": { state: "unavailable" } }, checkedAt: "2026-01-01T00:00:00.000Z", task: "private task", approvalContext: { plannedAction: "private action" } });
  assert.deepEqual(Object.keys(status).sort(), ["activeRuns", "awaitingApprovalRuns", "checkedAt", "codexReadOnlyStatus", "lastSafeErrorCode", "lastSuccessfulRunAt", "mockAvailable", "reachable", "serviceStatus", "version", "providerLayerStatus", "enabledProviderCount", "simulatedProviderCount", "routerVersion", "activeOrWaitingRuns", "updatedAt", "lastRunStatus"].sort());
  assert.equal(JSON.stringify(status).includes("private"), false);
  assert.equal(status.activeRuns, 2);
  assert.equal(status.awaitingApprovalRuns, 1);
  assert.equal(status.mockAvailable, true);
  assert.equal(status.codexReadOnlyStatus, "unavailable");
  assert.equal(status.version, "0.13.0-test");
});

test("persistent run store omits prompts, context and internal paths", async () => {
  const writes = new Map();
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const directory = path.join(process.cwd(), ".ai-router-data", "test-store");
  await fs.rm(directory, { recursive: true, force: true });
  const store = createRunStore({ runsDir: directory, latestRunFile: path.join(directory, "latest.json") });
  await store.saveRun({ runId: "r", task: "secret prompt", context: "secret context", repository: "C:\\private", executable: "C:\\private", approvalContext: { plannedAction: "secret" }, status: "succeeded" });
  const saved = JSON.stringify(await store.loadRun("r"));
  assert.equal(saved.includes("secret"), false);
  assert.equal(saved.includes("private"), false);
  await fs.rm(directory, { recursive: true, force: true });
});
