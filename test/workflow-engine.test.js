import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelWorkflow, completeWorkflow, createWorkflow, failStep, nextPendingStep,
  selectWorkflowType, startStep, succeedStep, validateWorkflow, workflowProgress,
  WORKFLOW_ROLES, WORKFLOW_TYPES
} from "../orchestrator/workflow-engine.js";

const plan = (overrides = {}) => ({ taskType: "everyday", complexity: "low", importance: "low", uncertainty: "low", reviewRequired: false, ...overrides });

test("workflow selection is deterministic and allowlisted", () => {
  assert.deepEqual(WORKFLOW_TYPES, ["direct", "plan_execute", "plan_execute_review"]);
  assert.deepEqual(WORKFLOW_ROLES, ["planner", "executor", "reviewer", "synthesizer"]);
  assert.equal(selectWorkflowType(plan()), "direct");
  assert.equal(selectWorkflowType(plan({ taskType: "planning", complexity: "medium" })), "plan_execute");
  assert.equal(selectWorkflowType(plan({ taskType: "code", importance: "high" })), "plan_execute_review");
  assert.equal(selectWorkflowType(plan({ uncertainty: "high" })), "plan_execute_review");
  assert.equal(selectWorkflowType(plan({ reviewRequired: true })), "plan_execute_review");
});

test("workflow types contain only their fixed role sequence", () => {
  assert.deepEqual(createWorkflow({ ...plan(), workflowType: "direct" }).steps.map((step) => step.role), ["executor", "synthesizer"]);
  assert.deepEqual(createWorkflow({ ...plan(), workflowType: "plan_execute" }).steps.map((step) => step.role), ["planner", "executor", "synthesizer"]);
  assert.deepEqual(createWorkflow({ ...plan(), workflowType: "plan_execute_review" }).steps.map((step) => step.role), ["planner", "executor", "reviewer", "synthesizer"]);
});

test("steps run once, sequentially and never in parallel", () => {
  const workflow = createWorkflow({ ...plan(), workflowType: "plan_execute" });
  assert.throws(() => startStep(workflow, "executor"), /in order/);
  startStep(workflow, "planner", "t1");
  assert.throws(() => startStep(workflow, "executor"), /already running/);
  succeedStep(workflow, "planner", "planned", "t2");
  assert.throws(() => startStep(workflow, "planner"), /not pending/);
  startStep(workflow, "executor", "t3");
  succeedStep(workflow, "executor", "executed", "t4");
  startStep(workflow, "synthesizer", "t5");
  succeedStep(workflow, "synthesizer", "done", "t6");
  completeWorkflow(workflow, "t7");
  assert.equal(workflow.status, "succeeded");
  assert.deepEqual(workflowProgress(workflow), { completedSteps: 3, totalSteps: 3 });
  assert.equal(workflow.steps.filter((step) => step.status === "running").length, 0);
});

test("executor failure stops reviewer and synthesizer", () => {
  const workflow = createWorkflow({ ...plan(), workflowType: "plan_execute_review" });
  startStep(workflow, "planner"); succeedStep(workflow, "planner", "ok");
  startStep(workflow, "executor"); failStep(workflow, "executor", "executor failed");
  assert.equal(workflow.status, "failed");
  assert.equal(workflow.steps.find((step) => step.role === "reviewer").status, "skipped");
  assert.equal(workflow.steps.find((step) => step.role === "synthesizer").status, "skipped");
  assert.equal(nextPendingStep(workflow), null);
});

test("reviewer failure skips synthesis", () => {
  const workflow = createWorkflow({ ...plan(), workflowType: "plan_execute_review" });
  for (const role of ["planner", "executor"]) { startStep(workflow, role); succeedStep(workflow, role, "ok"); }
  startStep(workflow, "reviewer"); failStep(workflow, "reviewer", "review failed");
  assert.equal(workflow.steps.find((step) => step.role === "synthesizer").status, "skipped");
  assert.equal(workflow.status, "failed");
});

test("cancellation stops running and pending steps", () => {
  const workflow = createWorkflow({ ...plan(), workflowType: "plan_execute_review" });
  startStep(workflow, "planner");
  cancelWorkflow(workflow);
  assert.equal(workflow.status, "cancelled");
  assert.equal(workflow.steps.filter((step) => step.status === "cancelled").length, 4);
  assert.equal(workflow.steps.filter((step) => step.status === "running").length, 0);
});

test("step summaries are bounded, flat and secret-masked", () => {
  const workflow = createWorkflow({ ...plan(), workflowType: "direct" });
  startStep(workflow, "executor");
  const step = succeedStep(workflow, "executor", `secret=my-private-value ${"x".repeat(800)}`);
  assert.equal(step.summary.length <= 500, true);
  assert.match(step.summary, /\[REDACTED\]/);
  assert.equal(typeof step.summary, "string");
});

test("unknown workflow types, roles and malformed parallel state are rejected", () => {
  assert.throws(() => createWorkflow({ ...plan(), workflowType: "custom" }), /Unsupported workflow type/);
  const workflow = createWorkflow({ ...plan(), workflowType: "direct" });
  workflow.steps[0].role = "hacker";
  assert.throws(() => validateWorkflow(workflow), /Unsupported workflow role/);
  const parallel = createWorkflow({ ...plan(), workflowType: "direct" });
  parallel.status = "running";
  parallel.steps[0].status = "running";
  parallel.steps[1].status = "running";
  assert.throws(() => validateWorkflow(parallel), /Only one/);
});
