import fs from "node:fs/promises";
import path from "node:path";
import { COCKPIT_STATUS_FILE, ROUTER_VERSION } from "./config.js";

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
  return { reachable: true, routerVersion: ROUTER_VERSION, lastRunStatus: run.status, activeOrWaitingRuns: ["created", "validating", "queued", "running", "awaiting_approval"].includes(run.status) ? 1 : 0, lastSuccessfulRunAt: run.status === "succeeded" ? run.finishedAt || run.updatedAt : null, lastSafeErrorCode: run.status === "timed_out" ? "STEP_TIMEOUT" : run.status === "failed" ? "ADAPTER_FAILED" : null, updatedAt: run.updatedAt };
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
