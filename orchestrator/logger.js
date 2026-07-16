import fs from "node:fs/promises";
import path from "node:path";
import { ROUTER_LOG_FILE } from "./config.js";
import { sanitizeText } from "./jsonl.js";

export function createLogger({ file = ROUTER_LOG_FILE, maxBytes = 512_000 } = {}) {
  return {
    async log({ level = "info", event, requestId = null, runId = null, workflowId = null, stepId = null, status = null, durationMs = null, safeMetadata = {} }) {
      const entry = { timestamp: new Date().toISOString(), level, event: sanitizeText(String(event || "unknown"), 80), requestId, runId, workflowId, stepId, status, ...(Number.isFinite(durationMs) ? { durationMs } : {}), safeMetadata: Object.fromEntries(Object.entries(safeMetadata || {}).slice(0, 12).map(([key, value]) => [sanitizeText(key, 40), typeof value === "string" ? sanitizeText(value, 160) : value])) };
      await fs.mkdir(path.dirname(file), { recursive: true });
      try { const stat = await fs.stat(file); if (stat.size > maxBytes) await fs.rename(file, `${file}.1`); } catch { /* first log */ }
      await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
    }
  };
}
export const logger = createLogger();
