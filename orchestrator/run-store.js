import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, LATEST_RUN_FILE, RUNS_DIR } from "./config.js";

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

function persistentRun(run) {
  const { task, context, repository, executable, gitBefore, approvalContext, ...safe } = run;
  return safe;
}

export function createRunStore({ runsDir, latestRunFile }) {
  return {
    async saveRun(run) {
      const safe = persistentRun(run);
      await atomicWrite(path.join(runsDir, `${run.runId}.json`), safe);
      await atomicWrite(latestRunFile, safe);
    },
    async loadRun(runId) {
      return JSON.parse(await fs.readFile(path.join(runsDir, `${runId}.json`), "utf8"));
    },
    async loadLatestRun() {
      try { return JSON.parse(await fs.readFile(latestRunFile, "utf8")); } catch { return null; }
    }
  };
}

const productionRunStore = createRunStore({ runsDir: RUNS_DIR, latestRunFile: LATEST_RUN_FILE });
export const saveRun = productionRunStore.saveRun;
export const loadRun = productionRunStore.loadRun;
export const loadLatestRun = productionRunStore.loadLatestRun;

export { DATA_DIR };
