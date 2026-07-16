import { ALLOWED_RUN_STATUSES, ERROR_CODES, SCHEMA_VERSION } from "./policy.js";

const RISK_LEVELS = new Set(["R0", "R1", "R2", "R3", "R4"]);

// A bounded, allowlist-only token. Adapters, routes, statuses and workflow types
// are already fixed enums; this defends against anything unexpected in a stored file.
function token(value, maximum = 40) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, maximum);
  return cleaned || null;
}

function id(value, maximum = 96) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, maximum);
  return cleaned || null;
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// The ONLY run projection allowed to leave the process for history, detail and
// diagnostics views. It deliberately carries no task text, prompts, context,
// file contents, stdout/stderr, local paths, secrets or full tool output — only
// enums, booleans, counts and timestamps.
export function projectRunSummary(run) {
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;
  const routePlan = run.routePlan && typeof run.routePlan === "object" ? run.routePlan : null;
  const approval = run.approval && typeof run.approval === "object" ? run.approval : null;
  const workflow = run.workflow && typeof run.workflow === "object" ? run.workflow : null;
  const status = ALLOWED_RUN_STATUSES.includes(run.status) ? run.status : "failed";
  return {
    runId: id(run.runId),
    requestId: id(run.requestId),
    schemaVersion: Number.isInteger(run.schemaVersion) ? run.schemaVersion : SCHEMA_VERSION,
    route: token(routePlan?.recommendedRoute),
    adapter: token(run.adapter),
    workflowType: token(workflow?.type),
    status,
    success: run.success === true || status === "succeeded",
    riskLevel: RISK_LEVELS.has(routePlan?.risk) ? routePlan.risk : null,
    approvalState: approval ? (token(approval.status) || "unknown") : "not_required",
    retryCount: Number.isFinite(run.retry?.count) ? run.retry.count : 0,
    startedAt: timestamp(run.startedAt),
    finishedAt: timestamp(run.finishedAt),
    durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
    safeErrorCode: ERROR_CODES.includes(run.errorCode) ? run.errorCode : null,
    warningsCount: Array.isArray(run.warnings) ? run.warnings.length : 0,
    resultAvailable: Boolean(run.resultSummary)
  };
}

// Re-validates an ALREADY projected summary read back from the history index.
// Unlike projectRunSummary (which reads a full run), this reads the flat summary
// shape, keeps only allowlisted keys and coerces types — defending against a
// tampered or partially corrupt index without losing the safe fields.
export function sanitizeStoredSummary(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const status = ALLOWED_RUN_STATUSES.includes(entry.status) ? entry.status : "failed";
  return {
    runId: id(entry.runId),
    requestId: id(entry.requestId),
    schemaVersion: Number.isInteger(entry.schemaVersion) ? entry.schemaVersion : SCHEMA_VERSION,
    route: token(entry.route),
    adapter: token(entry.adapter),
    workflowType: token(entry.workflowType),
    status,
    success: entry.success === true,
    riskLevel: RISK_LEVELS.has(entry.riskLevel) ? entry.riskLevel : null,
    approvalState: token(entry.approvalState) || "not_required",
    retryCount: Number.isFinite(entry.retryCount) ? entry.retryCount : 0,
    startedAt: timestamp(entry.startedAt),
    finishedAt: timestamp(entry.finishedAt),
    durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
    safeErrorCode: ERROR_CODES.includes(entry.safeErrorCode) ? entry.safeErrorCode : null,
    warningsCount: Number.isFinite(entry.warningsCount) ? entry.warningsCount : 0,
    resultAvailable: entry.resultAvailable === true
  };
}

// Newest first: prefer finishedAt, fall back to startedAt.
export function compareRunSummaryNewestFirst(a, b) {
  const keyA = Date.parse(a?.finishedAt || a?.startedAt || "") || 0;
  const keyB = Date.parse(b?.finishedAt || b?.startedAt || "") || 0;
  return keyB - keyA;
}
