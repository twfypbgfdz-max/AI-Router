import { record, rejectUnknownFields, safeCompactString } from "./cc-context-fields.js";
import { providerEgressPolicyInternals } from "./provider-egress-policy.js";
import { CcSnapshotError } from "./cc-snapshot-error.js";
import {
  CC_SNAPSHOT_SCHEMA_VERSION,
  CC_SNAPSHOT_MAX_ALERTS,
  CC_SNAPSHOT_MAX_SERVICES,
  CC_SNAPSHOT_MAX_GIT_REPOSITORIES,
  CC_SNAPSHOT_MAX_FAILED_CHECKS,
  CC_SNAPSHOT_MAX_PROJECTS,
  CC_SNAPSHOT_MAX_NEXT_STEP_SUMMARY_CHARS,
  CC_SNAPSHOT_MAX_KNOWLEDGE_QUERY_CHARS,
  CC_SNAPSHOT_EVIDENCE_STATES,
  CC_SNAPSHOT_ALERT_SEVERITIES,
  CC_SNAPSHOT_SERVICE_STATUSES,
  CC_SNAPSHOT_GIT_STATUSES,
  CC_SNAPSHOT_FAILED_CHECK_SEVERITIES,
  CC_SNAPSHOT_FAILED_CHECK_KINDS,
  CC_SNAPSHOT_PROJECT_PROGRESS_STATUSES,
  CC_SNAPSHOT_IMPACT_SCOPES
} from "./cc-snapshot-config.js";

const { containsSecretLikeContent, isExecutionRequest } = providerEgressPolicyInternals;

// Closed request contract: {schemaVersion, sections: {alerts, services,
// gitRepositories, failedChecks, projectProgress}, knowledgeQuery?}. Every
// section is independently optional (an omitted section is simply "not
// delivered", see evidence() below); the five keys themselves are the only
// ones ever accepted.
const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "sections", "knowledgeQuery"]);
const SECTION_NAMES = new Set(["alerts", "services", "gitRepositories", "failedChecks", "projectProgress"]);
const SECTION_FIELDS = new Set(["evidence", "freshness", "items"]);
const EVIDENCE_FIELDS = new Set(["status", "timestamp"]);
const FRESHNESS_VALUES = new Set(["fresh", "stale", "unknown"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,95}$/;

function fail(field, reason = "invalid_field") {
  throw new CcSnapshotError("VALIDATION_FAILED", "The snapshot request is invalid.", {
    safeDetails: { field, reason }
  });
}

function failSecurity(field, reason) {
  throw new CcSnapshotError("SECURITY_BLOCKED", "The request cannot be processed.", {
    safeDetails: { field, reason }
  });
}

const errors = Object.freeze({ fail, failSecurity });

// Mirrors recommendation-contract.js's private evidence() helper exactly
// (same validated behavior: unavailable by default, a future or unparsable
// timestamp always degrades to "unavailable", "available" without a valid
// timestamp is contradictory and also degrades) - duplicated here rather
// than imported because that file does not export it, the same situation
// every other per-endpoint contract file in this repo already accepts.
function evidence(value, field, nowMs) {
  if (!record(value)) return Object.freeze({ status: "unavailable", timestamp: null });
  rejectUnknownFields(value, EVIDENCE_FIELDS, field, errors);
  let status = typeof value.status === "string" && CC_SNAPSHOT_EVIDENCE_STATES.has(value.status) ? value.status : "unavailable";
  let timestamp = null;
  if (value.timestamp !== undefined && value.timestamp !== null) {
    if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) {
      status = "unavailable";
    } else {
      const parsed = Date.parse(value.timestamp);
      if (parsed > nowMs) status = "unavailable";
      else timestamp = new Date(parsed).toISOString();
    }
  }
  if (status === "available" && !timestamp) status = "unavailable";
  return Object.freeze({ status, timestamp });
}

function freshnessValue(value) {
  return typeof value === "string" && FRESHNESS_VALUES.has(value) ? value : "unknown";
}

// Domain status/severity fields never fail the request for an unrecognized
// value - an unknown status simply cannot activate a ranking rule (see
// cc-snapshot-ranking.js), same principle as recommendation-contract.js's
// state() helper. `fallback` lets failedChecks.severity default to
// "unknown" instead of "unavailable" (see CC_SNAPSHOT_FAILED_CHECK_SEVERITIES).
function enumOrFallback(value, allowed, fallback) {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function impactScope(value) {
  return enumOrFallback(value, CC_SNAPSHOT_IMPACT_SCOPES, "unknown");
}

function itemId(value, field, { required = true } = {}) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    if (required) fail(field, "required");
    return null;
  }
  if (!ID_PATTERN.test(normalized)) fail(field, "invalid_format");
  return normalized;
}

function alertCode(value, field) {
  const raw = safeCompactString(value, field, 64, errors, { required: true });
  return raw.toUpperCase().replace(/[^A-Z0-9_:-]/g, "_");
}

function normalizeAlert(value, index, nowMs) {
  const field = `sections.alerts.items[${index}]`;
  if (!record(value)) fail(field, "not_an_object");
  rejectUnknownFields(value, new Set(["alertId", "code", "severity", "impactScope", "evidence"]), field, errors);
  return Object.freeze({
    alertId: itemId(value.alertId, `${field}.alertId`),
    code: alertCode(value.code, `${field}.code`),
    severity: enumOrFallback(value.severity, CC_SNAPSHOT_ALERT_SEVERITIES, "unavailable"),
    impactScope: impactScope(value.impactScope),
    evidence: evidence(value.evidence, `${field}.evidence`, nowMs)
  });
}

function normalizeService(value, index, nowMs) {
  const field = `sections.services.items[${index}]`;
  if (!record(value)) fail(field, "not_an_object");
  rejectUnknownFields(value, new Set(["serviceId", "status", "impactScope", "evidence"]), field, errors);
  return Object.freeze({
    serviceId: itemId(value.serviceId, `${field}.serviceId`),
    status: enumOrFallback(value.status, CC_SNAPSHOT_SERVICE_STATUSES, "unavailable"),
    impactScope: impactScope(value.impactScope),
    evidence: evidence(value.evidence, `${field}.evidence`, nowMs)
  });
}

function normalizeGitRepository(value, index, nowMs) {
  const field = `sections.gitRepositories.items[${index}]`;
  if (!record(value)) fail(field, "not_an_object");
  rejectUnknownFields(value, new Set(["repoId", "branch", "status", "impactScope", "evidence"]), field, errors);
  return Object.freeze({
    repoId: itemId(value.repoId, `${field}.repoId`),
    branch: value.branch === undefined || value.branch === null ? null : safeCompactString(value.branch, `${field}.branch`, 200, errors, { required: true }),
    status: enumOrFallback(value.status, CC_SNAPSHOT_GIT_STATUSES, "unavailable"),
    impactScope: impactScope(value.impactScope),
    evidence: evidence(value.evidence, `${field}.evidence`, nowMs)
  });
}

function normalizeFailedCheck(value, index, nowMs) {
  const field = `sections.failedChecks.items[${index}]`;
  if (!record(value)) fail(field, "not_an_object");
  rejectUnknownFields(value, new Set(["checkId", "projectId", "kind", "severity", "impactScope", "evidence"]), field, errors);
  return Object.freeze({
    checkId: itemId(value.checkId, `${field}.checkId`),
    projectId: value.projectId === undefined || value.projectId === null ? null : itemId(value.projectId, `${field}.projectId`),
    kind: enumOrFallback(value.kind, CC_SNAPSHOT_FAILED_CHECK_KINDS, "unknown"),
    // Sonderregel (approved contract, Abschnitt 5): defaults to "unknown",
    // never "unavailable" - see CC_SNAPSHOT_FAILED_CHECK_SEVERITIES.
    severity: enumOrFallback(value.severity, CC_SNAPSHOT_FAILED_CHECK_SEVERITIES, "unknown"),
    impactScope: impactScope(value.impactScope),
    evidence: evidence(value.evidence, `${field}.evidence`, nowMs)
  });
}

function normalizeProjectProgressItem(value, index, nowMs) {
  const field = `sections.projectProgress.items[${index}]`;
  if (!record(value)) fail(field, "not_an_object");
  rejectUnknownFields(value, new Set(["projectId", "projectName", "progressStatus", "nextStepSummary", "impactScope", "evidence"]), field, errors);
  return Object.freeze({
    projectId: itemId(value.projectId, `${field}.projectId`),
    projectName: safeCompactString(value.projectName, `${field}.projectName`, 120, errors, { required: true }),
    progressStatus: enumOrFallback(value.progressStatus, CC_SNAPSHOT_PROJECT_PROGRESS_STATUSES, "unavailable"),
    nextStepSummary: value.nextStepSummary === undefined || value.nextStepSummary === null
      ? null
      : safeCompactString(value.nextStepSummary, `${field}.nextStepSummary`, CC_SNAPSHOT_MAX_NEXT_STEP_SUMMARY_CHARS, errors, { required: true }),
    impactScope: impactScope(value.impactScope),
    evidence: evidence(value.evidence, `${field}.evidence`, nowMs)
  });
}

function normalizeSection(rawSections, name, { maxItems, itemNormalizer, nowMs }) {
  const field = `sections.${name}`;
  const raw = record(rawSections) ? rawSections[name] : undefined;
  // An entirely omitted section is simply "not delivered" - the same
  // outcome as an explicit { evidence: { status: "unavailable" } }.
  if (raw === undefined || raw === null) {
    return Object.freeze({ evidence: Object.freeze({ status: "unavailable", timestamp: null }), freshness: "unknown", items: Object.freeze([]) });
  }
  if (!record(raw)) fail(field, "not_an_object");
  rejectUnknownFields(raw, SECTION_FIELDS, field, errors);
  const items = raw.items === undefined || raw.items === null ? [] : raw.items;
  if (!Array.isArray(items)) fail(`${field}.items`, "not_an_array");
  if (items.length > maxItems) fail(`${field}.items`, "exceeds_item_limit");
  return Object.freeze({
    evidence: evidence(raw.evidence, `${field}.evidence`, nowMs),
    freshness: freshnessValue(raw.freshness),
    items: Object.freeze(items.map((item, index) => itemNormalizer(item, index, nowMs)))
  });
}

export function normalizeCcSnapshotRequest(value, { now = () => new Date() } = {}) {
  if (!record(value)) fail("request", "not_an_object");
  rejectUnknownFields(value, TOP_LEVEL_FIELDS, "request", errors);
  if (value.schemaVersion !== CC_SNAPSHOT_SCHEMA_VERSION) fail("schemaVersion", "unsupported_version");

  const rawSections = value.sections;
  if (rawSections !== undefined && !record(rawSections)) fail("sections", "not_an_object");
  if (record(rawSections)) rejectUnknownFields(rawSections, SECTION_NAMES, "sections", errors);

  const nowMs = now().getTime();

  const sections = Object.freeze({
    alerts: normalizeSection(rawSections, "alerts", { maxItems: CC_SNAPSHOT_MAX_ALERTS, itemNormalizer: normalizeAlert, nowMs }),
    services: normalizeSection(rawSections, "services", { maxItems: CC_SNAPSHOT_MAX_SERVICES, itemNormalizer: normalizeService, nowMs }),
    gitRepositories: normalizeSection(rawSections, "gitRepositories", { maxItems: CC_SNAPSHOT_MAX_GIT_REPOSITORIES, itemNormalizer: normalizeGitRepository, nowMs }),
    failedChecks: normalizeSection(rawSections, "failedChecks", { maxItems: CC_SNAPSHOT_MAX_FAILED_CHECKS, itemNormalizer: normalizeFailedCheck, nowMs }),
    projectProgress: normalizeSection(rawSections, "projectProgress", { maxItems: CC_SNAPSHOT_MAX_PROJECTS, itemNormalizer: normalizeProjectProgressItem, nowMs })
  });

  let knowledgeQuery = null;
  if (value.knowledgeQuery !== undefined && value.knowledgeQuery !== null) {
    knowledgeQuery = safeCompactString(value.knowledgeQuery, "knowledgeQuery", CC_SNAPSHOT_MAX_KNOWLEDGE_QUERY_CHARS, errors, { required: true });
    if (isExecutionRequest(knowledgeQuery)) failSecurity("knowledgeQuery", "execution_request_blocked");
    if (containsSecretLikeContent(knowledgeQuery)) failSecurity("knowledgeQuery", "secret_like_content");
  }

  return Object.freeze({
    schemaVersion: CC_SNAPSHOT_SCHEMA_VERSION,
    sections,
    knowledgeQuery
  });
}
