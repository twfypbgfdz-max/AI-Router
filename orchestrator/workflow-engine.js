export const WORKFLOW_TYPES = Object.freeze(["direct", "plan_execute", "plan_execute_review"]);
export const WORKFLOW_ROLES = Object.freeze(["planner", "executor", "reviewer", "synthesizer"]);
export const STEP_STATUSES = Object.freeze(["pending", "running", "succeeded", "failed", "skipped", "cancelled"]);

const TYPE_SET = new Set(WORKFLOW_TYPES);
const ROLE_SET = new Set(WORKFLOW_ROLES);
const STATUS_SET = new Set(STEP_STATUSES);
export const ROLE_SEQUENCES = Object.freeze({
  direct: ["executor", "synthesizer"],
  plan_execute: ["planner", "executor", "synthesizer"],
  plan_execute_review: ["planner", "executor", "reviewer", "synthesizer"]
});

// The fixed role sequence for a workflow type (empty array for unknown types).
export function rolesForWorkflowType(type) { return [...(ROLE_SEQUENCES[type] || [])]; }

function safeText(value, maximum = 500) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/\b(api[_ -]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

export function selectWorkflowType(routePlan) {
  if (!routePlan || typeof routePlan !== "object") throw new Error("Route plan is required.");
  if (routePlan.reviewRequired === true || routePlan.complexity === "high" || routePlan.importance === "high" || routePlan.uncertainty === "high") return "plan_execute_review";
  if (routePlan.complexity === "medium" || ["planning", "writing", "code", "research", "finance"].includes(routePlan.taskType)) return "plan_execute";
  return "direct";
}

function validateType(type) { if (!TYPE_SET.has(type)) throw new Error("Unsupported workflow type."); }
function validateRole(role) { if (!ROLE_SET.has(role)) throw new Error("Unsupported workflow role."); }

export function createWorkflow(routePlan) {
  const type = routePlan?.workflowType || selectWorkflowType(routePlan);
  validateType(type);
  const steps = ROLE_SEQUENCES[type].map((role) => ({ id: role, role, status: "pending", startedAt: null, finishedAt: null, summary: "", errorSummary: null }));
  return { type, currentStep: "", status: "pending", startedAt: null, finishedAt: null, steps };
}

export function validateWorkflow(workflow) {
  validateType(workflow?.type);
  if (!new Set(["pending", "running", "succeeded", "failed", "cancelled"]).has(workflow.status)) throw new Error("Unsupported workflow status.");
  if (!Array.isArray(workflow.steps) || !workflow.steps.length) throw new Error("Workflow steps are required.");
  const expected = ROLE_SEQUENCES[workflow.type];
  if (workflow.steps.length !== expected.length) throw new Error("Workflow step sequence is invalid.");
  workflow.steps.forEach((step, index) => {
    validateRole(step.role);
    if (step.id !== step.role || step.role !== expected[index] || !STATUS_SET.has(step.status)) throw new Error("Workflow step sequence is invalid.");
  });
  if (workflow.steps.filter((step) => step.status === "running").length > 1) throw new Error("Only one workflow step may be running.");
  return true;
}

export function nextPendingStep(workflow) {
  validateWorkflow(workflow);
  return workflow.steps.find((step) => step.status === "pending") || null;
}

export function startStep(workflow, stepId, now = new Date().toISOString()) {
  validateWorkflow(workflow);
  const index = workflow.steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error("Unknown workflow step.");
  const step = workflow.steps[index];
  if (step.status !== "pending") throw new Error("Workflow step is not pending.");
  if (workflow.steps.some((item) => item.status === "running")) throw new Error("Another workflow step is already running.");
  if (workflow.steps.slice(0, index).some((item) => item.status !== "succeeded")) throw new Error("Workflow steps must run in order.");
  if (!workflow.startedAt) workflow.startedAt = now;
  workflow.status = "running";
  workflow.currentStep = step.id;
  step.status = "running";
  step.startedAt = now;
  validateWorkflow(workflow);
  return step;
}

export function succeedStep(workflow, stepId, summary, now = new Date().toISOString()) {
  const step = workflow.steps.find((item) => item.id === stepId);
  if (!step || step.status !== "running") throw new Error("Only the running workflow step can succeed.");
  step.status = "succeeded";
  step.finishedAt = now;
  step.summary = safeText(summary);
  step.errorSummary = null;
  workflow.currentStep = "";
  validateWorkflow(workflow);
  return step;
}

export function failStep(workflow, stepId, errorSummary, now = new Date().toISOString()) {
  const step = workflow.steps.find((item) => item.id === stepId);
  if (!step || step.status !== "running") throw new Error("Only the running workflow step can fail.");
  step.status = "failed";
  step.finishedAt = now;
  step.errorSummary = safeText(errorSummary) || "Controlled workflow step failure.";
  workflow.steps.forEach((item) => { if (item.status === "pending") { item.status = "skipped"; item.finishedAt = now; } });
  workflow.currentStep = "";
  workflow.status = "failed";
  workflow.finishedAt = now;
  validateWorkflow(workflow);
  return step;
}

export function cancelWorkflow(workflow, now = new Date().toISOString()) {
  validateWorkflow(workflow);
  workflow.steps.forEach((step) => {
    if (step.status === "running" || step.status === "pending") {
      step.status = "cancelled";
      step.finishedAt = now;
      if (step.errorSummary === null) step.errorSummary = step.status === "cancelled" ? "Workflow cancelled." : null;
    }
  });
  workflow.currentStep = "";
  workflow.status = "cancelled";
  workflow.finishedAt = now;
  validateWorkflow(workflow);
  return workflow;
}

export function completeWorkflow(workflow, now = new Date().toISOString()) {
  validateWorkflow(workflow);
  if (workflow.steps.some((step) => step.status !== "succeeded")) throw new Error("Workflow cannot complete before every step succeeds.");
  workflow.status = "succeeded";
  workflow.currentStep = "";
  workflow.finishedAt = now;
  validateWorkflow(workflow);
  return workflow;
}

export function workflowProgress(workflow) {
  validateWorkflow(workflow);
  return { completedSteps: workflow.steps.filter((step) => step.status === "succeeded").length, totalSteps: workflow.steps.length };
}

export { safeText as sanitizeWorkflowText };
