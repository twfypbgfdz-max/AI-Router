import fs from "node:fs/promises";
import path from "node:path";
import { MAX_LOG_BYTES, ROUTER_LOG_FILE } from "./config.js";
import { sanitizeText } from "./jsonl.js";

// Safe operational event names. Logging is metadata-only; payloads never carry
// task text, prompts, file contents, stdout/stderr, secrets, local paths or
// full request headers.
export const KNOWN_LOG_EVENTS = Object.freeze([
  "server_started", "server_stopped", "health_checked", "diagnostics_checked",
  "adapter_check_started", "adapter_check_completed", "adapter_check_failed",
  "run_listed", "run_details_viewed", "run_cancel_requested", "run_cancel_completed", "run_cancel_failed",
  "request_received", "workflow_started", "step_completed", "step_failed", "run_completed", "run_failed", "retrying"
]);

function classifyLogSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "none";
  if (bytes < 64_000) return "small";
  if (bytes < 256_000) return "medium";
  return "large";
}

export function createLogger({ file = ROUTER_LOG_FILE, maxBytes = MAX_LOG_BYTES } = {}) {
  return {
    async log({ level = "info", event, requestId = null, runId = null, workflowId = null, stepId = null, status = null, durationMs = null, safeMetadata = {} }) {
      const entry = { timestamp: new Date().toISOString(), level, event: sanitizeText(String(event || "unknown"), 80), requestId, runId, workflowId, stepId, status, ...(Number.isFinite(durationMs) ? { durationMs } : {}), safeMetadata: Object.fromEntries(Object.entries(safeMetadata || {}).slice(0, 12).map(([key, value]) => [sanitizeText(key, 40), typeof value === "string" ? sanitizeText(value, 160) : value])) };
      await fs.mkdir(path.dirname(file), { recursive: true });
      try { const stat = await fs.stat(file); if (stat.size > maxBytes) await fs.rename(file, `${file}.1`); } catch { /* first log */ }
      await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
    },
    // Safe logging health: presence and a coarse size class only — never the
    // path, exact bytes or any log content.
    async health() {
      const result = { present: false, sizeClass: "none", status: "unavailable" };
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.access(path.dirname(file), fs.constants.W_OK);
        result.status = "ok";
      } catch {
        return { present: false, sizeClass: "none", status: "unavailable" };
      }
      try {
        const stat = await fs.stat(file);
        result.present = true;
        result.sizeClass = classifyLogSize(stat.size);
      } catch { /* no log file yet is normal */ }
      return result;
    }
  };
}
export const logger = createLogger();
export const loggingHealth = () => logger.health();
