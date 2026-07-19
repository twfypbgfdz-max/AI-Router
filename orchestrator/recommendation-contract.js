import {
  RECOMMENDATION_MAX_AI_JOBS,
  RECOMMENDATION_MAX_ALERTS,
  RECOMMENDATION_MAX_WORKFLOWS,
  RECOMMENDATION_SCHEMA_VERSION
} from "./config.js";
import { RouterError } from "./contracts.js";

const ID = /^[a-z0-9][a-z0-9._:-]{0,95}$/;
const EVIDENCE_STATES = new Set(["available", "unknown", "unavailable"]);
const GENERAL_STATES = new Set(["ok", "warning", "active", "paused", "review", "archived", "blocked", "failed", "passed", "partial", "success", "fresh", "stale", "current", "ready", "not-ready", "review-required", "unreleased", "preparing", "released", "deployed", "not-deployed", "complete", "completed", "incomplete", "conflict", "planned", "running", "cancelled", "unknown", "unavailable"]);
const WORKFLOW_LEVELS = new Set(["read-only", "prepare-only"]);
const SEVERITIES = new Set(["notice", "warning", "critical", "unknown", "unavailable"]);

function record(value, field, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new RouterError("VALIDATION_FAILED", `${field} is required.`);
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) throw new RouterError("VALIDATION_FAILED", `${field} must be an object.`);
  return value;
}

function limitedArray(value, field, maximum) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RouterError("VALIDATION_FAILED", `${field} must be an array.`);
  if (value.length > maximum) throw new RouterError("PAYLOAD_TOO_LARGE", `${field} exceeds its item limit.`, { safeDetails: { field, limit: maximum } });
  return value;
}

function text(value, field, maximum, { required = false, fallback = null } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new RouterError("VALIDATION_FAILED", `${field} is required.`);
    return fallback;
  }
  if (typeof value !== "string") throw new RouterError("VALIDATION_FAILED", `${field} must be a string.`);
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (required && !normalized) throw new RouterError("VALIDATION_FAILED", `${field} must not be empty.`);
  if (normalized.length > maximum) throw new RouterError("PAYLOAD_TOO_LARGE", `${field} exceeds its allowed length.`, { safeDetails: { field, limit: maximum } });
  return normalized || fallback;
}

function id(value, field, required = false) {
  const normalized = text(value, field, 96, { required });
  if (normalized !== null && !ID.test(normalized)) throw new RouterError("VALIDATION_FAILED", `${field} contains unsupported characters.`);
  return normalized;
}

function state(value) {
  return typeof value === "string" && GENERAL_STATES.has(value) ? value : "unavailable";
}

function evidence(value, field, nowMs) {
  const source = record(value, field);
  let status = typeof source.status === "string" && EVIDENCE_STATES.has(source.status) ? source.status : "unavailable";
  let timestamp = null;
  if (source.timestamp !== undefined && source.timestamp !== null) {
    if (typeof source.timestamp !== "string" || !Number.isFinite(Date.parse(source.timestamp))) status = "unavailable";
    else {
      const parsed = Date.parse(source.timestamp);
      if (parsed > nowMs) status = "unavailable";
      else timestamp = new Date(parsed).toISOString();
    }
  }
  if (status === "available" && !timestamp) status = "unavailable";
  return Object.freeze({ status, timestamp });
}

function evidencedState(value, field, nowMs) {
  const source = record(value, field);
  return Object.freeze({ status: state(source.status), evidence: evidence(source.evidence, `${field}.evidence`, nowMs) });
}

function normalizeWorkflow(value, index) {
  const source = record(value, `workflows[${index}]`, true);
  const workflowId = id(source.id, `workflows[${index}].id`, true);
  const rawLevel = text(source.safetyLevel, `workflows[${index}].safetyLevel`, 32, { required: true });
  return Object.freeze({
    id: workflowId,
    safetyLevel: WORKFLOW_LEVELS.has(rawLevel) ? rawLevel : "not-allowed"
  });
}

function normalizeAlert(value, index, nowMs) {
  const source = record(value, `alerts[${index}]`, true);
  const code = text(source.code, `alerts[${index}].code`, 64, { required: true }).toUpperCase().replace(/[^A-Z0-9_:-]/g, "_");
  return Object.freeze({
    code,
    severity: SEVERITIES.has(source.severity) ? source.severity : "unavailable",
    evidence: evidence(source.evidence, `alerts[${index}].evidence`, nowMs)
  });
}

function normalizeAiJob(value, index, nowMs) {
  const source = record(value, `aiJobs[${index}]`, true);
  return Object.freeze({
    id: id(source.id, `aiJobs[${index}].id`, true),
    status: state(source.status),
    freshness: state(source.freshness),
    evidence: evidence(source.evidence, `aiJobs[${index}].evidence`, nowMs)
  });
}

export function normalizeRecommendationInput(input, { now = () => new Date() } = {}) {
  const source = record(input, "request", true);
  if (source.schemaVersion !== RECOMMENDATION_SCHEMA_VERSION) throw new RouterError("UNSUPPORTED_SCHEMA_VERSION", "Unsupported recommendation schema version.");
  if (source.mode !== "observe") throw new RouterError("EXECUTION_DISABLED", "Recommendation mode must remain observe.");
  const nowDate = now();
  const nowMs = nowDate.getTime();
  if (!Number.isFinite(nowMs)) throw new RouterError("INTERNAL_ERROR", "Recommendation clock is unavailable.");
  const project = record(source.project, "project", true);
  const quality = record(source.quality, "quality");
  const versions = record(quality.versions, "quality.versions");
  const normalized = {
    schemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    mode: "observe",
    project: Object.freeze({
      id: id(project.id, "project.id", true),
      name: text(project.name, "project.name", 120, { required: true }),
      status: state(project.status),
      evidence: evidence(project.evidence, "project.evidence", nowMs)
    }),
    quality: Object.freeze({
      status: evidencedState(quality.status, "quality.status", nowMs),
      tests: evidencedState(quality.tests, "quality.tests", nowMs),
      build: evidencedState(quality.build, "quality.build", nowMs),
      releaseReadiness: evidencedState(quality.releaseReadiness, "quality.releaseReadiness", nowMs),
      documentation: evidencedState(quality.documentation, "quality.documentation", nowMs),
      deployment: evidencedState(quality.deployment, "quality.deployment", nowMs),
      versions: Object.freeze({
        development: text(versions.development, "quality.versions.development", 100),
        stable: text(versions.stable, "quality.versions.stable", 100),
        release: text(versions.release, "quality.versions.release", 100),
        evidence: evidence(versions.evidence, "quality.versions.evidence", nowMs)
      })
    }),
    aiJobs: Object.freeze(limitedArray(source.aiJobs, "aiJobs", RECOMMENDATION_MAX_AI_JOBS).map((item, index) => normalizeAiJob(item, index, nowMs))),
    alerts: Object.freeze(limitedArray(source.alerts, "alerts", RECOMMENDATION_MAX_ALERTS).map((item, index) => normalizeAlert(item, index, nowMs))),
    workflows: Object.freeze(limitedArray(source.workflows, "workflows", RECOMMENDATION_MAX_WORKFLOWS).map(normalizeWorkflow)),
    evidence: evidence(source.evidence, "evidence", nowMs)
  };
  return Object.freeze(normalized);
}
