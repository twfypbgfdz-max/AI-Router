import fs from "node:fs/promises";
import path from "node:path";
import { COCKPIT_STATUS_FILE } from "./config.js";

function summary(value, maximum = 280) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum); }

export function projectCockpitStatus(run) {
  return {
    routerStatus: run.status === "created" || run.status === "queued" ? "validating" : run.status,
    runId: run.runId,
    taskSummary: summary(run.task, 180),
    route: [run.adapter === "mock" ? "mock" : "codex"],
    startedAt: run.startedAt || "",
    updatedAt: run.updatedAt,
    resultSummary: summary(run.resultSummary),
    risk: "R0",
    approvalRequired: false
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
