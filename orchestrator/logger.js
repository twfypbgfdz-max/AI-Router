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
  "request_received", "workflow_started", "step_completed", "step_failed", "run_completed", "run_failed", "retrying",
  "router_request_completed",
  // v0.13 provider-layer events (metadata only).
  "provider_registry_loaded", "provider_registry_invalid", "provider_selection_started", "provider_selected",
  "provider_selection_failed", "provider_fallback_used", "provider_simulation_started", "provider_simulation_completed",
  "provider_simulation_failed", "provider_workflow_started", "provider_workflow_completed", "provider_workflow_failed",
  "provider_result_synthesized", "providers_listed", "provider_details_viewed", "provider_selection_previewed",
  // Command-Center status contract (v1) events.
  "cc_status_checked", "cc_status_rejected",
  // R4 action layer: one event per lifecycle transition of an action
  // request. Metadata only - action id, origin, risk, approval status and
  // safe error code; never the question, never an executor result.
  "action_request_created", "action_request_validated", "action_request_approval_required",
  "action_request_approved", "action_request_rejected", "action_request_executing",
  "action_request_completed", "action_request_failed",
  // R5 action resolution + approval resume events. Metadata only - never
  // the question text, never raw resolver candidates.
  "action_resolution_resolved", "action_resolution_ambiguous", "action_resolution_unresolved",
  "action_pending_stored", "action_pending_resumed", "action_pending_expired", "action_pending_replay_blocked"
]);

const SAFE_TOKEN = (value, maximum = 60) => (typeof value === "string" ? value.replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, maximum) || null : null);

function classifyLogSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "none";
  if (bytes < 64_000) return "small";
  if (bytes < 256_000) return "medium";
  return "large";
}

export function createLogger({ file = ROUTER_LOG_FILE, maxBytes = MAX_LOG_BYTES } = {}) {
  return {
    async log({ level = "info", event, requestId = null, runId = null, workflowId = null, stepId = null, providerId = null, modelId = null, role = null, status = null, durationMs = null, safeMetadata = {} }) {
      const entry = { timestamp: new Date().toISOString(), level, event: sanitizeText(String(event || "unknown"), 80), requestId, runId, workflowId, stepId, providerId: SAFE_TOKEN(providerId), modelId: SAFE_TOKEN(modelId), role: SAFE_TOKEN(role, 20), status, ...(Number.isFinite(durationMs) ? { durationMs } : {}), safeMetadata: Object.fromEntries(Object.entries(safeMetadata || {}).slice(0, 12).map(([key, value]) => [sanitizeText(key, 40), typeof value === "string" ? sanitizeText(value, 160) : value])) };
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
