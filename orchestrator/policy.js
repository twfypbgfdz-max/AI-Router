export const SCHEMA_VERSION = 1;
export const ALLOWED_ADAPTERS = Object.freeze(["mock", "codex-cli"]);
export const ALLOWED_WORKFLOW_TYPES = Object.freeze(["direct", "plan_execute", "plan_execute_review"]);
export const ALLOWED_ROLES = Object.freeze(["planner", "executor", "reviewer", "synthesizer"]);
export const ALLOWED_RUN_STATUSES = Object.freeze(["created", "validating", "queued", "running", "awaiting_approval", "succeeded", "failed", "cancelled", "timed_out"]);
export const ALLOWED_WORKFLOW_STATUSES = Object.freeze(["pending", "running", "succeeded", "failed", "cancelled"]);
export const ALLOWED_STEP_STATUSES = Object.freeze(["pending", "running", "succeeded", "failed", "skipped", "cancelled"]);
export const ALLOWED_REQUESTED_MODES = Object.freeze(["simulation", "read-only"]);
export const ALLOWED_SOURCES = Object.freeze(["ui", "api", "cockpit", "local"]);
export const ALLOWED_ACTION_TYPES = Object.freeze(["analysis", "planning", "review", "synthesis", "simulation", "read_only_codex"]);
export const ERROR_CODES = Object.freeze(["INVALID_REQUEST", "UNSUPPORTED_SCHEMA_VERSION", "INVALID_TASK", "PAYLOAD_TOO_LARGE", "ADAPTER_NOT_ALLOWED", "MODE_NOT_ALLOWED", "ACTION_NOT_ALLOWED", "APPROVAL_REQUIRED", "APPROVAL_INVALID", "RUN_NOT_FOUND", "RUN_ALREADY_FINISHED", "ADAPTER_FAILED", "STEP_FAILED", "STEP_TIMEOUT", "WORKING_DIRECTORY_NOT_ALLOWED", "READ_ONLY_VIOLATION_DETECTED", "CODEX_CLI_NOT_FOUND", "CODEX_CLI_UNSUPPORTED", "CODEX_PROCESS_START_FAILED", "INTERNAL_ERROR"]);

export const hasAllowed = (list, value) => list.includes(value);
