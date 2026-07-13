import test from "node:test";
import assert from "node:assert/strict";
import { projectCockpitStatus } from "../orchestrator/cockpit-status.js";

test("Cockpit status remains compact and R0", () => { const status = projectCockpitStatus({ runId: "r", status: "succeeded", task: "x", startedAt: "a", updatedAt: "b", resultSummary: "ok" }); assert.equal(status.risk, "R0"); assert.deepEqual(status.route, ["codex"]); });

test("Cockpit status projects route-plan risk and approval", () => {
  const status = projectCockpitStatus({ runId: "r", adapter: "mock", status: "running", task: "push", startedAt: "a", updatedAt: "b", routePlan: { risk: "R3", approvalRequired: true } });
  assert.equal(status.risk, "R3");
  assert.equal(status.approvalRequired, true);
  assert.deepEqual(status.route, ["mock"]);
});

test("Cockpit approval projection is bounded, conservative and excludes sensitive details", () => {
  const status = projectCockpitStatus({
    runId: "r",
    adapter: "mock",
    status: "awaiting_approval",
    task: "risk",
    startedAt: "",
    updatedAt: "b",
    routePlan: { risk: "R4", approvalRequired: true },
    approval: { status: "pending", decisionNote: "must-not-leak", approvedAction: "must-not-leak" },
    approvalContext: {
      plannedAction: `secret=my-secret-value ${"x".repeat(300)}`,
      reversibility: "irreversible_or_limited",
      affectedResources: ["private-account"],
      possibleConsequences: ["private-detail"]
    }
  });
  assert.equal(status.routerStatus, "awaiting_approval");
  assert.equal(status.approvalStatus, "pending");
  assert.equal(status.approvalRequired, true);
  assert.equal(status.actionSummary.length <= 180, true);
  assert.match(status.actionSummary, /\[REDACTED\]/);
  assert.equal(status.reversible, false);
  assert.equal("approval" in status, false);
  assert.equal("approvalContext" in status, false);
  assert.equal(JSON.stringify(status).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(status).includes("private-account"), false);
  assert.equal(JSON.stringify(status).includes("private-detail"), false);
});

test("Cockpit workflow projection is compact and excludes step text", () => {
  const status = projectCockpitStatus({
    runId: "r",
    adapter: "mock",
    status: "running",
    task: "workflow",
    startedAt: "a",
    updatedAt: "b",
    workflow: {
      type: "plan_execute_review",
      currentStep: "reviewer",
      status: "running",
      steps: [
        { id: "planner", role: "planner", status: "succeeded", summary: "private-plan", errorSummary: null },
        { id: "executor", role: "executor", status: "succeeded", summary: "private-output", errorSummary: null },
        { id: "reviewer", role: "reviewer", status: "running", summary: "", errorSummary: "private-error" },
        { id: "synthesizer", role: "synthesizer", status: "pending", summary: "", errorSummary: null }
      ]
    }
  });
  assert.equal(status.workflowType, "plan_execute_review");
  assert.equal(status.currentRole, "reviewer");
  assert.equal(status.currentStep, "reviewer");
  assert.equal(status.completedSteps, 2);
  assert.equal(status.totalSteps, 4);
  assert.equal(status.workflowStatus, "running");
  assert.equal(status.reviewerRequired, true);
  assert.equal(status.reviewStatus, "running");
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes("private-plan"), false);
  assert.equal(serialized.includes("private-output"), false);
  assert.equal(serialized.includes("private-error"), false);
});
