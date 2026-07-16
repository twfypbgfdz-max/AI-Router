import test from "node:test";
import assert from "node:assert/strict";
import { projectCockpitStatus } from "../orchestrator/cockpit-status.js";
import { createRunStore } from "../orchestrator/run-store.js";

test("cockpit status is read-only and contains no task or approval content", () => {
  const status = projectCockpitStatus({ runId: "r", status: "awaiting_approval", task: "private task", approvalContext: { plannedAction: "private action" }, updatedAt: "now" });
  assert.deepEqual(Object.keys(status).sort(), ["activeOrWaitingRuns", "lastSafeErrorCode", "lastRunStatus", "lastSuccessfulRunAt", "reachable", "routerVersion", "updatedAt"].sort());
  assert.equal(JSON.stringify(status).includes("private"), false);
  assert.equal(status.activeOrWaitingRuns, 1);
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
