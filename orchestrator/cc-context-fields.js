import { providerEgressPolicyInternals } from "./provider-egress-policy.js";

const { containsSecretLikeContent } = providerEgressPolicyInternals;

// Mechanical extraction from cc-summary-contract.js: the closed Command-Center
// status context - field whitelist, per-field validators and the
// normalization function - shared by every contract that accepts this same
// "bereinigter Echtzeitkontext" shape (currently cc-summary, soon
// cc-knowledge). Behavior is byte-identical to the pre-extraction inline
// version; only the error-throwing is now injected via the `errors`
// parameter ({ fail(field, reason), failSecurity(field, reason) }) so each
// caller keeps throwing its own error class with its own codes/messages.
export const CONTEXT_FIELDS = new Set([
  "projectId", "projectName", "projectStatus", "phase", "branch", "clean",
  "changedFileCount", "untrackedFileCount", "testStatus", "buildStatus",
  "docsStatus", "releaseStatus", "activeAlertCount", "criticalAlertCount",
  "serviceStates", "responseTimeSummary", "cloudSummary", "milestoneCount",
  "blockedCount", "overdueCount", "progressPercent", "freshness"
]);
export const SERVICE_STATE_FIELDS = new Set(["name", "state"]);
export const SERVICE_STATE_VALUES = new Set(["ok", "degraded", "down", "unknown"]);
export const FRESHNESS_VALUES = new Set(["fresh", "stale", "unknown"]);
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_SERVICE_STATES = 20;
export const MAX_COUNT = 100_000;

export function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function rejectUnknownFields(value, allowed, field, errors) {
  if (Object.keys(value).some((key) => !allowed.has(key))) errors.fail(field, "unknown_field");
}

// Deliberately code-point based (not a regex with unicode escape ranges,
// which is easy to get subtly wrong): true for any ASCII control character
// or DEL, including bare CR/LF - status fields are always single-line.
export function hasControlCharacters(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
      return true;
    }
    if (code === 0x0a || code === 0x0d) return true;
  }
  return false;
}

// Every free-text field: bounded length, single line, no path/URL shape, no
// secret-like content. Deliberately conservative - this is status metadata,
// never prose.
export function safeCompactString(value, field, maxLength, errors, { required = false } = {}) {
  if (value === undefined) {
    if (required) errors.fail(field, "required");
    return undefined;
  }
  if (typeof value !== "string") errors.fail(field, "not_a_string");
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) errors.fail(field, "empty");
  if (normalized.length > maxLength) errors.fail(field, "too_long");
  if (hasControlCharacters(normalized)) errors.fail(field, "control_characters");
  if (normalized.includes("\\")) errors.fail(field, "path_like");
  if (normalized.includes("://")) errors.fail(field, "url_like");
  if (containsSecretLikeContent(normalized)) errors.failSecurity(field, "secret_like_content");
  return normalized;
}

export function safeCount(value, field, errors, { required = false } = {}) {
  if (value === undefined) {
    if (required) errors.fail(field, "required");
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) errors.fail(field, "invalid_count");
  return value;
}

export function safeBoolean(value, field, errors, { required = false } = {}) {
  if (value === undefined) {
    if (required) errors.fail(field, "required");
    return undefined;
  }
  if (typeof value !== "boolean") errors.fail(field, "not_a_boolean");
  return value;
}

export function safeEnum(value, field, allowed, errors, { required = false } = {}) {
  if (value === undefined) {
    if (required) errors.fail(field, "required");
    return undefined;
  }
  if (typeof value !== "string" || !allowed.has(value)) errors.fail(field, "invalid_enum");
  return value;
}

export function safeServiceStates(value, field, errors) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_SERVICE_STATES) errors.fail(field, "invalid_list");
  return value.map((entry, index) => {
    const entryField = `${field}[${index}]`;
    if (!record(entry)) errors.fail(entryField, "not_an_object");
    rejectUnknownFields(entry, SERVICE_STATE_FIELDS, entryField, errors);
    return Object.freeze({
      name: safeCompactString(entry.name, `${entryField}.name`, 40, errors, { required: true }),
      state: safeEnum(entry.state, `${entryField}.state`, SERVICE_STATE_VALUES, errors, { required: true })
    });
  });
}

export function safeProgressPercent(value, field, errors) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 100) errors.fail(field, "invalid_percent");
  return value;
}

// Validates and normalizes the closed CC-context object itself (the part
// shared across contracts). Does not touch the enclosing request's
// top-level fields (schemaVersion, reportType/question, ...) - callers
// validate those themselves before/after calling this.
export function normalizeCcContext(rawContext, errors) {
  if (!record(rawContext)) errors.fail("context", "not_an_object");
  rejectUnknownFields(rawContext, CONTEXT_FIELDS, "context", errors);
  const c = rawContext;

  const projectId = typeof c.projectId === "string" ? c.projectId.trim() : "";
  if (!PROJECT_ID_PATTERN.test(projectId)) errors.fail("context.projectId", "invalid_format");

  const rawResult = {
    projectId,
    projectName: safeCompactString(c.projectName, "context.projectName", 120, errors, { required: true }),
    projectStatus: safeCompactString(c.projectStatus, "context.projectStatus", 60, errors),
    phase: safeCompactString(c.phase, "context.phase", 60, errors),
    branch: safeCompactString(c.branch, "context.branch", 200, errors),
    clean: safeBoolean(c.clean, "context.clean", errors),
    changedFileCount: safeCount(c.changedFileCount, "context.changedFileCount", errors),
    untrackedFileCount: safeCount(c.untrackedFileCount, "context.untrackedFileCount", errors),
    testStatus: safeCompactString(c.testStatus, "context.testStatus", 60, errors),
    buildStatus: safeCompactString(c.buildStatus, "context.buildStatus", 60, errors),
    docsStatus: safeCompactString(c.docsStatus, "context.docsStatus", 60, errors),
    releaseStatus: safeCompactString(c.releaseStatus, "context.releaseStatus", 60, errors),
    activeAlertCount: safeCount(c.activeAlertCount, "context.activeAlertCount", errors),
    criticalAlertCount: safeCount(c.criticalAlertCount, "context.criticalAlertCount", errors),
    serviceStates: safeServiceStates(c.serviceStates, "context.serviceStates", errors),
    responseTimeSummary: safeCompactString(c.responseTimeSummary, "context.responseTimeSummary", 80, errors),
    cloudSummary: safeCompactString(c.cloudSummary, "context.cloudSummary", 160, errors),
    milestoneCount: safeCount(c.milestoneCount, "context.milestoneCount", errors),
    blockedCount: safeCount(c.blockedCount, "context.blockedCount", errors),
    overdueCount: safeCount(c.overdueCount, "context.overdueCount", errors),
    progressPercent: safeProgressPercent(c.progressPercent, "context.progressPercent", errors),
    freshness: safeEnum(c.freshness, "context.freshness", FRESHNESS_VALUES, errors)
  };
  // Built as a plain object first and stripped of undefined-valued keys
  // before freezing, so downstream prompt builders only ever see fields
  // that were actually supplied (freezing first would make delete throw).
  for (const key of Object.keys(rawResult)) {
    if (rawResult[key] === undefined) delete rawResult[key];
  }
  return Object.freeze(rawResult);
}
