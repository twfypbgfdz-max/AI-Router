import {
  TEXT_RESPONSE_MAX_COMBINED_CHARS,
  TEXT_RESPONSE_MAX_CONTEXT_CHARS,
  TEXT_RESPONSE_MAX_QUESTION_CHARS,
  TEXT_RESPONSE_SCHEMA_VERSION
} from "./text-response-config.js";
import { TextResponseError } from "./text-response-error.js";

const SOURCES = new Set(["cockpit", "internal_test"]);
const INTENTS = new Set([
  "auto", "general_question", "explanation", "analysis", "writing", "planning",
  "content_generation", "code_analysis", "project_status_summary",
  // Structured-report intents: the answer text must be one JSON object
  // matching the closed schema in structured-response-schema.js.
  "project_status_report", "git_change_report",
  // Commit C2a: structured knowledge-answer output ({answer, citedSources}).
  // Not reachable through any active route yet - added to the shared
  // pipeline in isolation, wired to a real handler only in Commit C2b.
  "knowledge_answer"
]);
const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "requestId", "source", "intent", "input", "context"]);
const INPUT_FIELDS = new Set(["type", "content"]);
const CONTEXT_FIELDS = new Set([
  "type", "content", "containsPrivateData", "privacyLevel", "sourceLabel", "capturedAt"
]);
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const PRIVACY_LEVELS = new Set(["external-provider-allowed", "local-only"]);

function record(value, field, { required = false } = {}) {
  if (value === undefined) {
    if (required) throw new TextResponseError("VALIDATION_FAILED", `${field} is required.`, { safeDetails: { field } });
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TextResponseError("VALIDATION_FAILED", `${field} must be an object.`, { safeDetails: { field } });
  }
  return value;
}

function rejectUnknownFields(value, allowed, field) {
  const issues = Object.keys(value).filter((key) => !allowed.has(key));
  if (issues.length) {
    throw new TextResponseError("VALIDATION_FAILED", `${field} contains unknown fields.`, {
      safeDetails: { field, issues: issues.slice(0, 8) }
    });
  }
}

function text(value, field, maximum, { required = false, sizeCode = "VALIDATION_FAILED" } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TextResponseError("VALIDATION_FAILED", `${field} is required.`, { safeDetails: { field } });
    return null;
  }
  if (typeof value !== "string") {
    throw new TextResponseError("VALIDATION_FAILED", `${field} must be a string.`, { safeDetails: { field } });
  }
  const normalized = value.normalize("NFKC").trim();
  if (required && !normalized) {
    throw new TextResponseError("VALIDATION_FAILED", `${field} must not be empty.`, { safeDetails: { field } });
  }
  if (normalized.length > maximum) {
    throw new TextResponseError(sizeCode, `${field} exceeds its configured limit.`, {
      safeDetails: { field, limit: maximum }
    });
  }
  return normalized;
}

function requiredBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new TextResponseError("SECURITY_BLOCKED", "Context privacy classification is incomplete.", {
      safeDetails: { reason: "privacy_classification_missing", field }
    });
  }
  return value;
}

function isoTimestamp(value, field, now) {
  const normalized = text(value, field, 64, { required: true });
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new TextResponseError("VALIDATION_FAILED", `${field} must be an ISO timestamp.`, {
      safeDetails: { field }
    });
  }
  if (parsed > now().getTime() + 300_000) {
    throw new TextResponseError("VALIDATION_FAILED", `${field} must not be in the future.`, {
      safeDetails: { field }
    });
  }
  return new Date(parsed).toISOString();
}

function normalizeContext(rawContext, now) {
  const context = record(rawContext, "context", { required: true });
  rejectUnknownFields(context, CONTEXT_FIELDS, "context");
  if (context.type !== "text") {
    throw new TextResponseError("VALIDATION_FAILED", "context.type must be text.", {
      safeDetails: { field: "context.type" }
    });
  }
  const content = text(context.content, "context.content", TEXT_RESPONSE_MAX_CONTEXT_CHARS, {
    required: true,
    sizeCode: "INPUT_TOO_LARGE"
  });
  const containsPrivateData = requiredBoolean(context.containsPrivateData, "context.containsPrivateData");
  if (context.privacyLevel === undefined || context.privacyLevel === null || context.privacyLevel === "") {
    throw new TextResponseError("SECURITY_BLOCKED", "Context privacy classification is incomplete.", {
      safeDetails: { reason: "privacy_classification_missing", field: "context.privacyLevel" }
    });
  }
  if (typeof context.privacyLevel !== "string" || !PRIVACY_LEVELS.has(context.privacyLevel)) {
    throw new TextResponseError("SECURITY_BLOCKED", "Context privacy classification is invalid.", {
      safeDetails: { reason: "privacy_classification_invalid", field: "context.privacyLevel" }
    });
  }
  return Object.freeze({
    type: "text",
    content,
    containsPrivateData,
    privacyLevel: context.privacyLevel,
    sourceLabel: text(context.sourceLabel, "context.sourceLabel", 120, { required: true }),
    capturedAt: isoTimestamp(context.capturedAt, "context.capturedAt", now)
  });
}

export function safeTextResponseIdentity(value) {
  const requestId = typeof value?.requestId === "string" && REQUEST_ID.test(value.requestId)
    ? value.requestId
    : null;
  const source = SOURCES.has(value?.source) ? value.source : null;
  return Object.freeze({ requestId, source });
}

export function normalizeTextResponseRequest(value, { now = () => new Date() } = {}) {
  const request = record(value, "request", { required: true });
  rejectUnknownFields(request, TOP_LEVEL_FIELDS, "request");
  if (request.schemaVersion !== TEXT_RESPONSE_SCHEMA_VERSION) {
    throw new TextResponseError("VALIDATION_FAILED", "Unsupported text response schema version.", {
      safeDetails: { field: "schemaVersion" }
    });
  }
  if (typeof request.requestId !== "string" || !REQUEST_ID.test(request.requestId)) {
    throw new TextResponseError("VALIDATION_FAILED", "requestId is required and must use the supported format.", {
      safeDetails: { field: "requestId" }
    });
  }
  if (!SOURCES.has(request.source)) {
    throw new TextResponseError("VALIDATION_FAILED", "source is not allowed.", {
      safeDetails: { field: "source" }
    });
  }
  if (!INTENTS.has(request.intent)) {
    throw new TextResponseError("VALIDATION_FAILED", "intent is not allowed.", {
      safeDetails: { field: "intent" }
    });
  }
  const input = record(request.input, "input", { required: true });
  rejectUnknownFields(input, INPUT_FIELDS, "input");
  if (input.type !== "text") {
    throw new TextResponseError("VALIDATION_FAILED", "input.type must be text.", {
      safeDetails: { field: "input.type" }
    });
  }
  const content = text(input.content, "input.content", TEXT_RESPONSE_MAX_QUESTION_CHARS, {
    required: true,
    sizeCode: "INPUT_TOO_LARGE"
  });
  const context = request.context === undefined ? null : normalizeContext(request.context, now);
  if (content.length + (context?.content.length || 0) > TEXT_RESPONSE_MAX_COMBINED_CHARS) {
    throw new TextResponseError("INPUT_TOO_LARGE", "Combined input and context exceed the configured limit.", {
      safeDetails: { field: "input+context", limit: TEXT_RESPONSE_MAX_COMBINED_CHARS }
    });
  }
  return Object.freeze({
    schemaVersion: TEXT_RESPONSE_SCHEMA_VERSION,
    requestId: request.requestId,
    source: request.source,
    intent: request.intent,
    input: Object.freeze({ type: "text", content }),
    context
  });
}
