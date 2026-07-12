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
