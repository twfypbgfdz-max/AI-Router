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
