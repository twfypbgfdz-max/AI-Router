import test from "node:test";
import assert from "node:assert/strict";
import { createMockAdapter } from "../orchestrator/mock-adapter.js";
import { projectCockpitStatus } from "../orchestrator/cockpit-status.js";
import { RunService } from "../orchestrator/run-service.js";

const gitState = { repository: "C:\\repo", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" };
const finalStatuses = new Set(["succeeded", "failed", "cancelled", "timed_out", "awaiting_approval"]);

async function waitFor(service, runId, statuses = finalStatuses, maximumMs = 2_000) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    const run = service.get(runId);
    if (statuses.has(run?.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Run did not reach expected status.");
}

function approvalService() {
  let mockStarts = 0;
  let codexStarts = 0;
  let gitCalls = 0;
  const states = [];
  const mock = createMockAdapter({ stepDelayMs: 1 });
  const service = new RunService({
    adapters: {
      mock: { run(options) { mockStarts += 1; return mock.run(options); } },
      "codex-cli": { resolveExecutable: async () => "codex", run: async () => { codexStarts += 1; return {}; } }
    },
    git: { captureGitState: async () => { gitCalls += 1; return { ...gitState }; }, compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async (run) => { states.push(run.status); },
    publish: async () => {}
  });
  return { service, states, mockStarts: () => mockStarts, codexStarts: () => codexStarts, gitCalls: () => gitCalls };
}

test("approval is bound to one run, consumed once and starts only safe mock simulation", async () => {
  const fixture = approvalService();
  const created = await fixture.service.create({ task: "Lösche alle Dateien und pushe auf main", adapter: "mock" });
  const waiting = await waitFor(fixture.service, created.runId);
  assert.equal(waiting.status, "awaiting_approval");
  assert.deepEqual(waiting.approval, {
    required: true,
    status: "pending",
    requestedAt: waiting.createdAt,
    decidedAt: null,
    decision: null,
    decisionNote: "",
    approvedAction: "",
    consumed: false
  });
  const gitCallsBeforeDecision = fixture.gitCalls();
  await fixture.service.decideApproval(waiting.runId, { decision: "approve", decisionNote: "secret=my-private-value lokal bestätigt" });
  const completed = await waitFor(fixture.service, waiting.runId, new Set(["succeeded", "failed"]));
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.approval.status, "approved");
  assert.equal(completed.approval.decision, "approved");
  assert.equal(completed.approval.consumed, true);
  assert.ok(completed.approval.decidedAt);
  assert.match(completed.approval.decisionNote, /\[REDACTED\]/);
  assert.equal(completed.approval.approvedAction, "Lösche alle Dateien und pushe auf main");
  assert.equal(fixture.mockStarts(), 1);
  assert.equal(fixture.codexStarts(), 0);
  assert.equal(fixture.gitCalls(), gitCallsBeforeDecision);
  assert.match(completed.resultSummary, /Freigabe wurde registriert/i);
  assert.match(completed.resultSummary, /nicht real ausgeführt/i);
  assert.match(completed.resultSummary, /Simulation/i);
  assert.ok(fixture.states.includes("queued") && fixture.states.includes("running") && fixture.states.includes("succeeded"));
  const cockpit = projectCockpitStatus(completed);
  assert.equal(cockpit.approvalRequired, false);
  assert.equal(cockpit.approvalStatus, "approved");
  await assert.rejects(fixture.service.decideApproval(waiting.runId, { decision: "approve" }), /not awaiting approval|already been consumed/);
  await assert.rejects(fixture.service.decideApproval(waiting.runId, { decision: "reject" }), /not awaiting approval|already been consumed/);
});

test("rejection is terminal, logged and starts no adapter", async () => {
  const fixture = approvalService();
  const created = await fixture.service.create({ task: "Sende eine E-Mail an alle", adapter: "mock" });
  const waiting = await waitFor(fixture.service, created.runId);
  const rejected = await fixture.service.decideApproval(waiting.runId, { decision: "reject", decisionNote: "Nicht freigegeben" });
  assert.equal(rejected.status, "cancelled");
  assert.equal(rejected.approval.status, "rejected");
  assert.equal(rejected.approval.decision, "rejected");
  assert.equal(rejected.approval.consumed, true);
  assert.ok(rejected.approval.decidedAt);
  assert.equal(fixture.mockStarts(), 0);
  assert.equal(fixture.codexStarts(), 0);
  assert.match(rejected.resultSummary, /Freigabe abgelehnt/i);
  assert.match(rejected.resultSummary, /keine Aktion ausgeführt/i);
  await assert.rejects(fixture.service.decideApproval(waiting.runId, { decision: "reject" }), /not awaiting approval|already been consumed/);
  await assert.rejects(fixture.service.decideApproval(waiting.runId, { decision: "approve" }), /not awaiting approval|already been consumed/);
});

test("simultaneous approve and reject consume exactly one decision", async () => {
  const fixture = approvalService();
  const created = await fixture.service.create({ task: "Lösche alle Dateien", adapter: "mock" });
  const waiting = await waitFor(fixture.service, created.runId);
  const outcomes = await Promise.allSettled([
    fixture.service.decideApproval(waiting.runId, { decision: "approve" }),
    fixture.service.decideApproval(waiting.runId, { decision: "reject" })
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const loser = outcomes.find((outcome) => outcome.status === "rejected");
  assert.match(loser.reason.message, /not awaiting approval|already been consumed/);
  const completed = await waitFor(fixture.service, waiting.runId, new Set(["succeeded", "cancelled", "failed"]));
  assert.equal(completed.approval.consumed, true);
  assert.ok(["approved", "rejected"].includes(completed.approval.status));
  assert.ok(fixture.mockStarts() <= 1);
  assert.equal(fixture.codexStarts(), 0);
});

test("approval cannot be transferred to a different or unknown run id", async () => {
  const fixture = approvalService();
  const first = await fixture.service.create({ task: "Dateien löschen", adapter: "mock" });
  await waitFor(fixture.service, first.runId);
  const second = await fixture.service.create({ task: "Produktiven Branch pushen", adapter: "mock" });
  await waitFor(fixture.service, second.runId);
  await assert.rejects(fixture.service.decideApproval("run_unknown", { decision: "approve" }), /Run not found/);
  await fixture.service.decideApproval(first.runId, { decision: "reject" });
  assert.equal(fixture.service.get(second.runId).approval.status, "pending");
  assert.equal(fixture.service.get(second.runId).approval.consumed, false);
});

test("invalid or oversized decisions do not consume approval", async () => {
  const fixture = approvalService();
  const created = await fixture.service.create({ task: "Committen und pushen", adapter: "mock" });
  const waiting = await waitFor(fixture.service, created.runId);
  await assert.rejects(fixture.service.decideApproval(waiting.runId, { decision: "maybe" }), /approve or reject/);
  await assert.rejects(fixture.service.decideApproval(waiting.runId, { decision: "approve", decisionNote: "x".repeat(1_001) }), /bounded string/);
  assert.equal(waiting.approval.status, "pending");
  assert.equal(waiting.approval.consumed, false);
});
