import fs from "node:fs/promises";
import path from "node:path";
import { COCKPIT_STATUS_FILE } from "./config.js";

function summary(value, maximum = 280) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]")
    .replace(/\b(api[_ -]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

export function projectCockpitStatus(run) {
  const workflow = run.workflow && typeof run.workflow === "object" ? run.workflow : null;
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  const current = steps.find((step) => step.id === workflow?.currentStep) || null;
  const reviewer = steps.find((step) => step.role === "reviewer") || null;
  return {
    routerStatus: run.status === "created" || run.status === "queued" ? "validating" : run.status,
    runId: run.runId,
    taskSummary: summary(run.task, 180),
    route: [run.adapter === "mock" ? "mock" : "codex"],
    startedAt: run.startedAt || "",
    updatedAt: run.updatedAt,
    resultSummary: summary(run.resultSummary),
    risk: run.routePlan?.risk || "R0",
    approvalRequired: run.approval ? run.approval.status === "pending" : run.routePlan?.approvalRequired === true,
    approvalStatus: run.approval?.status || null,
    actionSummary: summary(run.approvalContext?.plannedAction, 180),
    reversible: run.approvalContext?.reversibility === "irreversible_or_limited" ? false : null,
    workflowType: ["direct", "plan_execute", "plan_execute_review"].includes(workflow?.type) ? workflow.type : null,
    currentRole: ["planner", "executor", "reviewer", "synthesizer"].includes(current?.role) ? current.role : null,
    currentStep: summary(workflow?.currentStep, 40),
    completedSteps: steps.filter((step) => step.status === "succeeded").length,
    totalSteps: Math.min(steps.length, 4),
    workflowStatus: ["pending", "running", "succeeded", "failed", "cancelled"].includes(workflow?.status) ? workflow.status : null,
    reviewerRequired: !!reviewer,
    reviewStatus: reviewer && ["pending", "running", "succeeded", "failed", "skipped", "cancelled"].includes(reviewer.status) ? reviewer.status : "not_required"
  };
}

export function createCockpitStatusStore({ file }) {
  return {
    async saveCockpitStatus(run) {
      const value = projectCockpitStatus(run);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await fs.rename(temporary, file);
      return value;
    },
    async loadCockpitStatus() {
      try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
    }
  };
}

const productionCockpitStatusStore = createCockpitStatusStore({ file: COCKPIT_STATUS_FILE });
export const saveCockpitStatus = productionCockpitStatusStore.saveCockpitStatus;
export const loadCockpitStatus = productionCockpitStatusStore.loadCockpitStatus;
