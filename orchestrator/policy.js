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
export const ERROR_CODES = Object.freeze(["INVALID_REQUEST", "UNSUPPORTED_SCHEMA_VERSION", "VALIDATION_FAILED", "INVALID_TASK", "PAYLOAD_TOO_LARGE", "SOURCE_NOT_ALLOWED", "MODE_NOT_ALLOWED", "CAPABILITY_NOT_ALLOWED", "CONFLICTING_CONSTRAINTS", "NO_SAFE_ROUTE", "SIMULATION_FAILED", "INTERNAL_VALIDATION_FAILED", "ADAPTER_NOT_ALLOWED", "ACTION_NOT_ALLOWED", "ACTION_NOT_ALLOWLISTED", "EXECUTION_DISABLED", "ORIGIN_NOT_ALLOWED", "ROUTE_NOT_FOUND", "TIMEOUT", "UNAVAILABLE", "APPROVAL_REQUIRED", "APPROVAL_INVALID", "RUN_NOT_FOUND", "RUN_ALREADY_FINISHED", "ADAPTER_FAILED", "STEP_FAILED", "STEP_TIMEOUT", "WORKING_DIRECTORY_NOT_ALLOWED", "READ_ONLY_VIOLATION_DETECTED", "CODEX_CLI_NOT_FOUND", "CODEX_CLI_UNSUPPORTED", "CODEX_PROCESS_START_FAILED", "INTERNAL_ERROR",
  // v0.13 provider-layer error codes (safe contract, same shape).
  "PROVIDER_NOT_FOUND", "PROVIDER_NOT_ALLOWED", "PROVIDER_DISABLED", "PROVIDER_UNAVAILABLE", "PROVIDER_CAPABILITY_MISMATCH", "PROVIDER_ROLE_NOT_SUPPORTED", "PROVIDER_TASK_NOT_SUPPORTED", "PROVIDER_CONFIGURATION_INVALID", "PROVIDER_SELECTION_FAILED", "PROVIDER_EXECUTION_NOT_IMPLEMENTED", "MODEL_NOT_ALLOWED", "MODEL_NOT_AVAILABLE",
  // R4 action-layer error codes. Registered here rather than in a second,
  // parallel list so that the existing diagnostics and cockpit surfaces
  // (diagnostics.js, cockpit-status.js) keep recognising them as safe codes.
  "ACTION_NOT_REGISTERED", "ACTION_PARAMETERS_INVALID", "ACTION_APPROVAL_REQUIRED", "ACTION_APPROVAL_REJECTED",
  "ACTION_EXECUTOR_UNAVAILABLE", "ACTION_EXECUTION_FAILED", "ACTION_REQUEST_INVALID",
  // R5 action resolution + approval resume error codes.
  "ACTION_PENDING_NOT_FOUND", "ACTION_PENDING_EXPIRED", "ACTION_PENDING_ALREADY_DECIDED",
  // R6 first safe executor (app.open) error codes.
  "APP_NOT_ALLOWED", "APP_NOT_INSTALLED", "APP_LAUNCH_FAILED",
  // R7 - Approval Source Hardening + Action Rate Limit error codes.
  "APPROVAL_AUTH_REQUIRED", "APPROVAL_SOURCE_UNTRUSTED", "ACTION_RATE_LIMITED",
  // R9 - Run-Approval BFF error code. Missing/invalid/expired/reused nonce
  // on POST /api/runs/:id/approval/ui.
  "APPROVAL_NONCE_INVALID"]);

// --- v0.13 provider layer allowlists (central, closed sets). ---
// Only mock-local and codex-local-readonly are ever technically executable.
// claude/openai/gemini-simulated are LOCAL SIMULATIONS: no API, no network, no keys.
export const ALLOWED_PROVIDER_IDS = Object.freeze(["mock-local", "codex-local-readonly", "claude-simulated", "openai-simulated", "gemini-simulated"]);
export const EXECUTABLE_PROVIDER_IDS = Object.freeze(["mock-local", "codex-local-readonly"]);
export const ALLOWED_PROVIDER_TYPES = Object.freeze(["mock", "codex", "claude", "openai", "gemini"]);
export const ALLOWED_PROVIDER_ADAPTER_IDS = Object.freeze(["mock", "codex-cli-readonly"]);
export const ALLOWED_EXECUTION_MODES = Object.freeze(["simulation", "local-read-only"]);
export const ALLOWED_PROVIDER_AVAILABILITY = Object.freeze(["available", "unavailable", "unknown", "invalid"]);
export const ALLOWED_CAPABILITIES = Object.freeze(["analysis", "planning", "coding", "debugging", "architecture", "review", "writing", "summarization", "research-planning", "synthesis", "classification", "file-analysis", "image-analysis"]);
// Never permitted in v0.13 — any provider claiming one of these is invalid.
export const FORBIDDEN_CAPABILITIES = Object.freeze(["web-research", "file-write", "shell-write", "git-write", "deployment", "email-send", "pc-control", "calendar-write", "external-api-write", "destructive-action"]);
export const ALLOWED_MODEL_IDS = Object.freeze(["claude-general-sim", "claude-architecture-sim", "openai-general-sim", "openai-coding-sim", "gemini-research-sim", "mock-deterministic-v1", "codex-local-readonly"]);
export const ALLOWED_PROVIDER_WORKFLOW_PROFILES = Object.freeze(["single_provider", "specialist_chain", "safe_review_chain"]);
export const ALLOWED_SELECTION_MODES = Object.freeze(["automatic", "manual"]);
export const PROVIDER_CLASS_LEVELS = Object.freeze(["low", "medium", "high"]);

export const ROUTER_REQUEST_CAPABILITIES = Object.freeze([
  "status.read", "capabilities.read", "routes.read", "recommendation.read", "simulate",
  ...ALLOWED_CAPABILITIES
]);
export const ROUTER_BLOCKED_ACTIONS = Object.freeze([
  "execute", "file.write", "file.delete", "git.commit", "git.push", "email.send",
  "calendar.write", "pc.action", "shell.run", "deployment.trigger", "secret.read",
  "external-provider.call"
]);
export const ROUTER_ACTIVE_MODES = Object.freeze(["recommendation", "simulation"]);
export const ROUTER_FUTURE_MODES = Object.freeze(["approval_required", "execution"]);
export const ROUTER_RESPONSE_STATUSES = Object.freeze(["recommended", "simulated", "rejected", "failed"]);

export const hasAllowed = (list, value) => list.includes(value);
