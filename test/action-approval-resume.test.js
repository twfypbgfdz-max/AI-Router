import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createActionRegistry } from "../orchestrator/action/action-registry.js";
import { createActionService } from "../orchestrator/action/action-service.js";
import { createActionAudit } from "../orchestrator/action/action-audit.js";
import { createActionPendingStore } from "../orchestrator/action/action-pending-store.js";
import { createActionApprovalService } from "../orchestrator/action/action-approval-service.js";

function silentAudit() {
  return createActionAudit({ logger: { log: async () => {} } });
}

function gatedRegistry({ executor = (parameters) => ({ opened: parameters.target }) } = {}) {
  return createActionRegistry([
    { id: "app.open", description: "d", risk: "medium", requiresApproval: true, parameters: { target: { type: "enum", required: true, values: ["spotify"] } }, executor }
  ]);
}

async function fixture({ ttlMs = 60_000, now = () => Date.now(), executor } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-action-pending-"));
  const registry = gatedRegistry({ executor });
  const actionService = createActionService({ registry, audit: silentAudit() });
  const pendingStore = createActionPendingStore({ dir, ttlMs, now });
  const approvalService = createActionApprovalService({ actionService, pendingStore, logger: { log: async () => {} } });
  return { dir, actionService, pendingStore, approvalService };
}

async function submitAndPersist(fx, input = { actionId: "app.open", parameters: { target: "spotify" }, origin: "api" }) {
  const result = await fx.actionService.submit(input);
  assert.equal(result.status, "approval_required");
  await fx.pendingStore.create({ requestId: result.requestId, actionId: result.actionId, parameters: result.parameters, origin: result.origin, risk: result.risk });
  return result;
}

// --- persistence on approval_required ---------------------------------------

test("a request that stops at approval_required is persisted and readable", async () => {
  const fx = await fixture();
  const submitted = await submitAndPersist(fx);
  const pending = await fx.pendingStore.get(submitted.requestId);
  assert.equal(pending.status, "approval_required");
  assert.equal(pending.actionId, "app.open");
  assert.deepEqual(pending.parameters, { target: "spotify" });
});

// --- approve resumes exactly once -------------------------------------------

test("approval resumes the persisted request and executes it exactly once", async () => {
  const seen = [];
  const fx = await fixture({ executor: (parameters) => { seen.push(parameters); return { opened: parameters.target }; } });
  const submitted = await submitAndPersist(fx);

  const result = await fx.approvalService.decide(submitted.requestId, { decision: "approve", decidedBy: "felix" });
  assert.equal(result.status, "completed");
  assert.equal(result.executed, true);
  assert.deepEqual(result.result, { opened: "spotify" });
  assert.equal(seen.length, 1);

  const finalRecord = await fx.pendingStore.get(submitted.requestId);
  assert.equal(finalRecord.status, "completed");

  await assert.rejects(fx.approvalService.decide(submitted.requestId, { decision: "approve", decidedBy: "felix" }), { code: "ACTION_PENDING_ALREADY_DECIDED" });
  await assert.rejects(fx.approvalService.decide(submitted.requestId, { decision: "reject", decidedBy: "felix" }), { code: "ACTION_PENDING_ALREADY_DECIDED" });
  assert.equal(seen.length, 1, "a decided request must never execute a second time");
});

// --- reject is terminal, never executes -------------------------------------

test("rejection is terminal and never executes the action", async () => {
  const seen = [];
  const fx = await fixture({ executor: (parameters) => { seen.push(parameters); return {}; } });
  const submitted = await submitAndPersist(fx);

  const result = await fx.approvalService.decide(submitted.requestId, { decision: "reject", decidedBy: "felix", note: "nicht jetzt" });
  assert.equal(result.status, "rejected");
  assert.equal(result.executed, false);
  assert.equal(seen.length, 0);

  const finalRecord = await fx.pendingStore.get(submitted.requestId);
  assert.equal(finalRecord.status, "rejected");

  await assert.rejects(fx.approvalService.decide(submitted.requestId, { decision: "approve", decidedBy: "felix" }), { code: "ACTION_PENDING_ALREADY_DECIDED" });
  assert.equal(seen.length, 0);
});

// --- unknown request id ------------------------------------------------------

test("a decision for an unknown request id is rejected with a safe error", async () => {
  const fx = await fixture();
  await assert.rejects(fx.approvalService.decide("act_1_deadbeef", { decision: "approve", decidedBy: "felix" }), { code: "ACTION_PENDING_NOT_FOUND" });
});

// --- expiry / TTL -------------------------------------------------------------

test("an expired pending request cannot be approved or rejected", async () => {
  let clock = 1_000_000;
  const fx = await fixture({ ttlMs: 1_000, now: () => clock });
  const submitted = await submitAndPersist(fx);
  clock += 5_000; // past the 1s TTL

  await assert.rejects(fx.approvalService.decide(submitted.requestId, { decision: "approve", decidedBy: "felix" }), { code: "ACTION_PENDING_EXPIRED" });
  const record = await fx.pendingStore.get(submitted.requestId);
  assert.equal(record.status, "expired");

  // Expired stays expired - a second attempt still fails, never falls back
  // to "already decided" or, worse, "not found".
  await assert.rejects(fx.approvalService.decide(submitted.requestId, { decision: "reject", decidedBy: "felix" }), { code: "ACTION_PENDING_EXPIRED" });
});

// --- concurrent decisions consume exactly one --------------------------------

test("simultaneous approve and reject for the same request consume exactly one decision", async () => {
  const seen = [];
  const fx = await fixture({ executor: (parameters) => { seen.push(parameters); return {}; } });
  const submitted = await submitAndPersist(fx);

  const outcomes = await Promise.allSettled([
    fx.approvalService.decide(submitted.requestId, { decision: "approve", decidedBy: "felix" }),
    fx.approvalService.decide(submitted.requestId, { decision: "reject", decidedBy: "felix" })
  ]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1);
  assert.ok(seen.length === 0 || seen.length === 1, "the executor must run at most once");
});

// --- decisions do not accept arbitrary/manipulated parameters ---------------

test("a decision cannot smuggle different parameters than what was persisted", async () => {
  const seen = [];
  const fx = await fixture({ executor: (parameters) => { seen.push(parameters); return {}; } });
  const submitted = await submitAndPersist(fx);

  // decide() only ever forwards decision/decidedBy/note - the actionId and
  // parameters always come from the persisted pending record, never from
  // the caller's decision body, so there is no field here through which a
  // caller could redirect execution to a different action or target.
  const result = await fx.approvalService.decide(submitted.requestId, {
    decision: "approve",
    decidedBy: "felix",
    actionId: "file.delete.everything",
    parameters: { target: "not-spotify" }
  });
  assert.equal(result.actionId, "app.open");
  assert.deepEqual(result.result, {});
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { target: "spotify" });
});

// --- tampered persisted parameters are revalidated against the registry ----

test("parameters tampered with directly in the pending store are rejected on resume, not blindly trusted", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-action-pending-tamper-"));
  const registry = gatedRegistry();
  const actionService = createActionService({ registry, audit: silentAudit() });
  const pendingStore = createActionPendingStore({ dir });
  const approvalService = createActionApprovalService({ actionService, pendingStore, logger: { log: async () => {} } });

  const submitted = await actionService.submit({ actionId: "app.open", parameters: { target: "spotify" }, origin: "api" });
  await pendingStore.create({ requestId: submitted.requestId, actionId: submitted.actionId, parameters: submitted.parameters, origin: submitted.origin, risk: submitted.risk });

  // Simulate on-disk tampering: an out-of-enum value written directly into
  // the persisted record, bypassing action-service.js entirely.
  const file = path.join(dir, `${submitted.requestId}.json`);
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  raw.parameters = { target: "not-an-allowed-value" };
  await fs.writeFile(file, JSON.stringify(raw), "utf8");

  const result = await approvalService.decide(submitted.requestId, { decision: "approve", decidedBy: "felix" });
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "ACTION_PARAMETERS_INVALID");

  const finalRecord = await pendingStore.get(submitted.requestId);
  assert.equal(finalRecord.status, "failed", "a tampered/failed resume must still be marked terminal, never left resumable");
});

// --- resolver output is re-validated before persistence ---------------------

test("the resolver's own candidate is re-validated by the registry before an approval_required request is even persisted", async () => {
  // app.open with a target NOT in its own enum can never be produced by
  // action-service.js's submit() in the first place - parameter validation
  // happens before approval/persistence, so there is nothing to persist.
  const fx = await fixture();
  const result = await fx.actionService.submit({ actionId: "app.open", parameters: { target: "not-spotify" }, origin: "api" });
  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "ACTION_PARAMETERS_INVALID");
  assert.equal(await fx.pendingStore.get(result.requestId), null, "an invalid request must never reach the pending store");
});
