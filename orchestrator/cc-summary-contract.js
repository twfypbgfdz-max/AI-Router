import { CC_SUMMARY_REPORT_TYPES, CC_SUMMARY_SCHEMA_VERSION } from "./cc-summary-config.js";
import { CcSummaryError } from "./cc-summary-error.js";
import { providerEgressPolicyInternals } from "./provider-egress-policy.js";

const { containsSecretLikeContent } = providerEgressPolicyInternals;

// Closed request contract: only compact, already-sanitized status fields.
// No input.content, no free prompt, no paths, diffs, logs or URLs - there is
// no field capable of carrying them, and every string is additionally
// bounded, single-line and checked against the same secret-pattern guard
// the shared text-response pipeline uses.
const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "reportType", "context"]);
const CONTEXT_FIELDS = new Set([
  "projectId", "projectName", "projectStatus", "phase", "branch", "clean",
  "changedFileCount", "untrackedFileCount", "testStatus", "buildStatus",
  "docsStatus", "releaseStatus", "activeAlertCount", "criticalAlertCount",
  "serviceStates", "responseTimeSummary", "cloudSummary", "milestoneCount",
  "blockedCount", "overdueCount", "progressPercent", "freshness"
]);
const SERVICE_STATE_FIELDS = new Set(["name", "state"]);
const SERVICE_STATE_VALUES = new Set(["ok", "degraded", "down", "unknown"]);
const FRESHNESS_VALUES = new Set(["fresh", "stale", "unknown"]);
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SERVICE_STATES = 20;
const MAX_COUNT = 100_000;

function fail(field, reason = "invalid_field") {
  throw new CcSummaryError("VALIDATION_FAILED", "The summary request is invalid.", {
    safeDetails: { field, reason }
  });
}

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed, field) {
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(field, "unknown_field");
}

// Deliberately code-point based (not a regex with unicode escape ranges,
// which is easy to get subtly wrong): true for any ASCII control character
// or DEL, including bare CR/LF - status fields are always single-line.
function hasControlCharacters(value) {
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
function safeCompactString(value, field, maxLength, { required = false } = {}) {
  if (value === undefined) {
    if (required) fail(field, "required");
    return undefined;
  }
  if (typeof value !== "string") fail(field, "not_a_string");
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) fail(field, "empty");
  if (normalized.length > maxLength) fail(field, "too_long");
  if (hasControlCharacters(normalized)) fail(field, "control_characters");
  if (normalized.includes("\\")) fail(field, "path_like");
  if (normalized.includes("://")) fail(field, "url_like");
  if (containsSecretLikeContent(normalized)) {
    throw new CcSummaryError("SECURITY_BLOCKED", "Secret-like content cannot be sent to the provider.", {
      safeDetails: { field, reason: "secret_like_content" }
    });
  }
  return normalized;
}

function safeCount(value, field, { required = false } = {}) {
  if (value === undefined) {
    if (required) fail(field, "required");
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) fail(field, "invalid_count");
  return value;
}

function safeBoolean(value, field, { required = false } = {}) {
  if (value === undefined) {
    if (required) fail(field, "required");
    return undefined;
  }
  if (typeof value !== "boolean") fail(field, "not_a_boolean");
  return value;
}

function safeEnum(value, field, allowed, { required = false } = {}) {
  if (value === undefined) {
    if (required) fail(field, "required");
    return undefined;
  }
  if (typeof value !== "string" || !allowed.has(value)) fail(field, "invalid_enum");
  return value;
}

function safeServiceStates(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_SERVICE_STATES) fail(field, "invalid_list");
  return value.map((entry, index) => {
    const entryField = `${field}[${index}]`;
    if (!record(entry)) fail(entryField, "not_an_object");
    rejectUnknownFields(entry, SERVICE_STATE_FIELDS, entryField);
    return Object.freeze({
      name: safeCompactString(entry.name, `${entryField}.name`, 40, { required: true }),
      state: safeEnum(entry.state, `${entryField}.state`, SERVICE_STATE_VALUES, { required: true })
    });
  });
}

function safeProgressPercent(value, field) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 100) fail(field, "invalid_percent");
  return value;
}

export function normalizeCcSummaryRequest(value) {
  if (!record(value)) fail("request", "not_an_object");
  rejectUnknownFields(value, TOP_LEVEL_FIELDS, "request");
  if (value.schemaVersion !== CC_SUMMARY_SCHEMA_VERSION) fail("schemaVersion", "unsupported_version");
  if (typeof value.reportType !== "string" || !CC_SUMMARY_REPORT_TYPES.includes(value.reportType)) {
    fail("reportType", "invalid_enum");
  }
  if (!record(value.context)) fail("context", "not_an_object");
  rejectUnknownFields(value.context, CONTEXT_FIELDS, "context");
  const c = value.context;

  const projectId = typeof c.projectId === "string" ? c.projectId.trim() : "";
  if (!PROJECT_ID_PATTERN.test(projectId)) fail("context.projectId", "invalid_format");

  const rawContext = {
    projectId,
    projectName: safeCompactString(c.projectName, "context.projectName", 120, { required: true }),
    projectStatus: safeCompactString(c.projectStatus, "context.projectStatus", 60),
    phase: safeCompactString(c.phase, "context.phase", 60),
    branch: safeCompactString(c.branch, "context.branch", 200),
    clean: safeBoolean(c.clean, "context.clean"),
    changedFileCount: safeCount(c.changedFileCount, "context.changedFileCount"),
    untrackedFileCount: safeCount(c.untrackedFileCount, "context.untrackedFileCount"),
    testStatus: safeCompactString(c.testStatus, "context.testStatus", 60),
    buildStatus: safeCompactString(c.buildStatus, "context.buildStatus", 60),
    docsStatus: safeCompactString(c.docsStatus, "context.docsStatus", 60),
    releaseStatus: safeCompactString(c.releaseStatus, "context.releaseStatus", 60),
    activeAlertCount: safeCount(c.activeAlertCount, "context.activeAlertCount"),
    criticalAlertCount: safeCount(c.criticalAlertCount, "context.criticalAlertCount"),
    serviceStates: safeServiceStates(c.serviceStates, "context.serviceStates"),
    responseTimeSummary: safeCompactString(c.responseTimeSummary, "context.responseTimeSummary", 80),
    cloudSummary: safeCompactString(c.cloudSummary, "context.cloudSummary", 160),
    milestoneCount: safeCount(c.milestoneCount, "context.milestoneCount"),
    blockedCount: safeCount(c.blockedCount, "context.blockedCount"),
    overdueCount: safeCount(c.overdueCount, "context.overdueCount"),
    progressPercent: safeProgressPercent(c.progressPercent, "context.progressPercent"),
    freshness: safeEnum(c.freshness, "context.freshness", FRESHNESS_VALUES)
  };
  // Built as a plain object first and stripped of undefined-valued keys
  // before freezing, so the internal prompt builder only ever sees fields
  // that were actually supplied (freezing first would make delete throw).
  for (const key of Object.keys(rawContext)) {
    if (rawContext[key] === undefined) delete rawContext[key];
  }
  const context = Object.freeze(rawContext);

  return Object.freeze({
    schemaVersion: CC_SUMMARY_SCHEMA_VERSION,
    reportType: value.reportType,
    context
  });
}
