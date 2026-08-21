import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveActionIntent } from "../orchestrator/action/action-resolver.js";
import { buildActionRequestFromIntent } from "../orchestrator/action/action-intent-bridge.js";
import { actionRegistry } from "../orchestrator/action/action-registry.js";
import { actionService } from "../orchestrator/action/action-service.js";
import { createActionAudit } from "../orchestrator/action/action-audit.js";
import { createActionPendingStore } from "../orchestrator/action/action-pending-store.js";
import { createActionApprovalService } from "../orchestrator/action/action-approval-service.js";
import { appLauncher } from "../orchestrator/action/app-launcher.js";

// R6 - Resolver -> Executor, exercised through the real, shipped default
// registry/actionService (not a fixture) end to end: "Öffne Spotify" ->
// app.open/spotify -> approval required -> approve -> real executor call
// (with only the leaf app-launcher.js OS call substituted, same technique
// as test/action-approval-api.test.js) -> correct result, never a fake
// success on a launch failure, never an execution without approval.

function silentAudit() {
  return createActionAudit({ logger: { log: async () => {} } });
}

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-r6-integration-"));
  const pendingStore = createActionPendingStore({ dir, ttlMs: 60_000 });
  const approvalService = createActionApprovalService({ actionService, pendingStore, logger: { log: async () => {} } });
  return { dir, pendingStore, approvalService };
}

function withMockedLaunch(t, impl) {
  const original = appLauncher.launch;
  appLauncher.launch = impl;
  t.after(() => { appLauncher.launch = original; });
}

test("R6: \"Öffne Spotify\" resolves, requires approval, and approval executes the real registered action", async (t) => {
  const seen = [];
  withMockedLaunch(t, async (app) => { seen.push(app); return { ok: true, app, state: "opened" }; });

  const resolution = resolveActionIntent("Öffne Spotify.", actionRegistry);
  assert.equal(resolution.resolution, "resolved");
  assert.equal(resolution.actionId, "app.open");
  assert.deepEqual(resolution.params, { target: "spotify" });

  const built = buildActionRequestFromIntent({ intent: "action" }, { question: "Öffne Spotify.", registry: actionRegistry });
  assert.equal(built.actionId, "app.open");

  const submitted = await actionService.submit({ actionId: built.actionId, parameters: built.parameters, origin: "jarvis-ask" });
  assert.equal(submitted.status, "approval_required");
  assert.equal(seen.length, 0, "no execution may happen before an explicit approval");

  const fx = await fixture();
  await fx.pendingStore.create({
    requestId: submitted.requestId, actionId: submitted.actionId, parameters: submitted.parameters,
    origin: submitted.origin, risk: submitted.risk
  });

  const result = await fx.approvalService.decide(submitted.requestId, { decision: "approve", decidedBy: "felix" });
  assert.equal(result.status, "completed");
  assert.equal(result.executed, true);
  assert.deepEqual(result.result, { ok: true, app: "spotify", state: "opened" });
  assert.deepEqual(seen, ["spotify"], "the executor must be called exactly once, with exactly the resolved target");
});

test("R6: a rejected approval never reaches the executor", async (t) => {
  const seen = [];
  withMockedLaunch(t, async (app) => { seen.push(app); return { ok: true, app, state: "opened" }; });

  const built = buildActionRequestFromIntent({ intent: "action" }, { question: "Starte Obsidian.", registry: actionRegistry });
  const submitted = await actionService.submit({ actionId: built.actionId, parameters: built.parameters, origin: "jarvis-ask" });
  assert.equal(submitted.status, "approval_required");

  const fx = await fixture();
  await fx.pendingStore.create({
    requestId: submitted.requestId, actionId: submitted.actionId, parameters: submitted.parameters,
    origin: submitted.origin, risk: submitted.risk
  });

  const result = await fx.approvalService.decide(submitted.requestId, { decision: "reject", decidedBy: "felix", note: "nicht jetzt" });
  assert.equal(result.status, "rejected");
  assert.equal(result.executed, false);
  assert.equal(seen.length, 0);
});

test("R6: a real launch failure normalizes to a failed result, never a fabricated success", async (t) => {
  withMockedLaunch(t, async () => {
    const error = new Error("simulated launch failure");
    error.code = "APP_LAUNCH_FAILED";
    throw error;
  });

  const built = buildActionRequestFromIntent({ intent: "action" }, { question: "Öffne Spotify.", registry: actionRegistry });
  const submitted = await actionService.submit({ actionId: built.actionId, parameters: built.parameters, origin: "jarvis-ask" });

  const fx = await fixture();
  await fx.pendingStore.create({
    requestId: submitted.requestId, actionId: submitted.actionId, parameters: submitted.parameters,
    origin: submitted.origin, risk: submitted.risk
  });

  const result = await fx.approvalService.decide(submitted.requestId, { decision: "approve", decidedBy: "felix" });
  assert.equal(result.status, "failed");
  assert.equal(result.executed, false);
  assert.equal(result.error.code, "APP_LAUNCH_FAILED");
  assert.equal(result.result, null);
});

test("R6: an app outside the registered enum (e.g. Notepad) never resolves and never reaches the executor", async (t) => {
  const seen = [];
  withMockedLaunch(t, async (app) => { seen.push(app); return { ok: true, app, state: "opened" }; });

  const resolution = resolveActionIntent("Öffne Notepad.", actionRegistry);
  assert.equal(resolution.resolution, "unresolved");
  assert.equal(seen.length, 0);
});
