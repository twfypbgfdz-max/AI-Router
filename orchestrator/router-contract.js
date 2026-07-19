import crypto from "node:crypto";
import { MAX_PROJECT_LENGTH, MAX_SOURCE_LENGTH, MAX_TASK_LENGTH, ROUTER_API_DEFAULT_MODE, ROUTER_API_SCHEMA_VERSION, ROUTER_REQUEST_ID_MAX_LENGTH } from "./config.js";
import { RouterError } from "./contracts.js";
import { ALLOWED_PROVIDER_IDS, ALLOWED_PROVIDER_WORKFLOW_PROFILES, PROVIDER_CLASS_LEVELS, ROUTER_ACTIVE_MODES, ROUTER_BLOCKED_ACTIONS, ROUTER_REQUEST_CAPABILITIES } from "./policy.js";

const SOURCES = new Set(["cockpit", "api", "internal_test", "ui", "local"]);
const INTENTS = new Set(["auto", "project_status_summary", "general_recommendation", "code_analysis", "research", "planning", "content_generation", "status_check"]);
const INPUT_TYPES = new Set(["text"]);
const CONTENT_TYPES = new Set(["text", "code", "file", "image", "mixed"]);
const REQUIRED_TOOLS = new Set(["repository-read", "file-read", "image-input", "web-research"]);
const CONTEXT_SIZES = new Set(["small", "medium", "large"]);
const PRIVACY_LEVELS = new Set(["local-only", "sensitive", "standard"]);
const RISK_LEVELS = new Set(["low", "medium", "high"]);
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "requestId", "correlationId", "timestamp", "source", "mode", "intent", "input", "context", "constraints", "options", "metadata"]);
const INPUT_FIELDS = new Set(["type", "content"]);
const CONTEXT_FIELDS = new Set(["project", "contentType", "contextSize", "requiresFreshData", "containsPrivateData", "requiredTools", "client"]);
const CONSTRAINT_FIELDS = new Set(["allowedCapabilities", "forbiddenCapabilities", "riskLevel", "privacyLevel", "costClass", "latencyClass", "allowFileProcessing"]);
const OPTION_FIELDS = new Set(["preferredProvider", "providerProfile", "allowActions"]);
const METADATA_FIELDS = new Set(["clientVersion", "tags"]);

function isValidIsoDateTime(value) {
  const match = ISO_DATE_TIME.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, fraction = "0", timezone, , offsetHour = "0", offsetMinute = "0"] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const milliseconds = Number(fraction.padEnd(3, "0"));
  const local = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], milliseconds));
  if (local.getUTCFullYear() !== parts[0] || local.getUTCMonth() !== parts[1] - 1 || local.getUTCDate() !== parts[2] || local.getUTCHours() !== parts[3] || local.getUTCMinutes() !== parts[4] || local.getUTCSeconds() !== parts[5]) return false;
  if (timezone !== "Z") {
    const offsetHours = Number(offsetHour);
    const offsetMinutes = Number(offsetMinute);
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function object(value, field, fallback = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) throw new RouterError("VALIDATION_FAILED", `${field} must be an object.`);
  return value;
}

function rejectUnknownFields(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new RouterError("VALIDATION_FAILED", `${field} contains unknown fields.`, { safeDetails: { field, issues: unknown.slice(0, 8) } });
}

function normalizedText(value, field, maximum, { required = false, fallback = null } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new RouterError("VALIDATION_FAILED", `${field} is required.`);
    return fallback;
  }
  if (typeof value !== "string") throw new RouterError("VALIDATION_FAILED", `${field} must be a string.`);
  const result = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (required && !result) throw new RouterError("VALIDATION_FAILED", `${field} must not be empty.`);
  if (result.length > maximum) throw new RouterError("PAYLOAD_TOO_LARGE", `${field} exceeds its allowed length.`, { safeDetails: { field, limit: maximum } });
  return result || fallback;
}

function optionalId(value, field, fallback = null, maximum = ROUTER_REQUEST_ID_MAX_LENGTH) {
  const result = normalizedText(value, field, maximum, { fallback });
  if (result !== null && !/^[A-Za-z0-9_.:-]+$/.test(result)) throw new RouterError("VALIDATION_FAILED", `${field} contains unsupported characters.`);
  return result;
}

function boolean(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new RouterError("VALIDATION_FAILED", `${field} must be a boolean.`);
  return value;
}

function enumValue(value, field, allowed, fallback = null, code = "VALIDATION_FAILED") {
  const result = normalizedText(value, field, 64, { fallback });
  if (!allowed.has(result)) throw new RouterError(code, `${field} is not allowed.`);
  return result;
}

function stringList(value, field, allowed, fallback) {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) throw new RouterError("VALIDATION_FAILED", `${field} must be an array.`);
  if (value.length > 24) throw new RouterError("PAYLOAD_TOO_LARGE", `${field} exceeds its item limit.`, { safeDetails: { field, limit: 24 } });
  const output = [];
  for (const item of value) {
    const normalized = normalizedText(item, field, 64, { required: true });
    if (!allowed.has(normalized)) throw new RouterError("CAPABILITY_NOT_ALLOWED", `${field} contains an unsupported capability.`, { safeDetails: { field } });
    if (!output.includes(normalized)) output.push(normalized);
  }
  return output;
}

function tags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) throw new RouterError("VALIDATION_FAILED", "metadata.tags must be a small array.");
  return value.map((item) => normalizedText(item, "metadata.tags", 40, { required: true }));
}

function requiredTools(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) throw new RouterError("VALIDATION_FAILED", "context.requiredTools must be a small array.");
  const output = [];
  for (const item of value) {
    const tool = normalizedText(item, "context.requiredTools", 40, { required: true });
    if (!REQUIRED_TOOLS.has(tool)) throw new RouterError("VALIDATION_FAILED", "context.requiredTools contains an unsupported tool.");
    if (!output.includes(tool)) output.push(tool);
  }
  return output;
}

export function normalizeRouterRequest(input, { now = () => new Date() } = {}) {
  const source = object(input, "request", null);
  if (!source) throw new RouterError("INVALID_REQUEST", "Request must be a JSON object.");
  rejectUnknownFields(source, TOP_LEVEL_FIELDS, "request");
  if (source.schemaVersion !== ROUTER_API_SCHEMA_VERSION) throw new RouterError("UNSUPPORTED_SCHEMA_VERSION", "Unsupported schema version.", { safeDetails: { supportedVersions: [ROUTER_API_SCHEMA_VERSION] } });

  const requestSource = normalizedText(source.source, "source", MAX_SOURCE_LENGTH, { required: true });
  if (!SOURCES.has(requestSource)) throw new RouterError("SOURCE_NOT_ALLOWED", "source is not allowed.");
  const mode = enumValue(source.mode, "mode", new Set(ROUTER_ACTIVE_MODES), ROUTER_API_DEFAULT_MODE, "MODE_NOT_ALLOWED");
  const intent = enumValue(source.intent, "intent", INTENTS, "auto");

  const inputData = object(source.input, "input", null);
  if (!inputData) throw new RouterError("VALIDATION_FAILED", "input is required.");
  rejectUnknownFields(inputData, INPUT_FIELDS, "input");
  const inputType = enumValue(inputData.type, "input.type", INPUT_TYPES, null);
  const content = normalizedText(inputData.content, "input.content", MAX_TASK_LENGTH, { required: true });

  const context = object(source.context, "context");
  rejectUnknownFields(context, CONTEXT_FIELDS, "context");
  const constraints = object(source.constraints, "constraints");
  rejectUnknownFields(constraints, CONSTRAINT_FIELDS, "constraints");
  const options = object(source.options, "options");
  rejectUnknownFields(options, OPTION_FIELDS, "options");
  const metadata = object(source.metadata, "metadata");
  rejectUnknownFields(metadata, METADATA_FIELDS, "metadata");

  const allowedCapabilities = stringList(constraints.allowedCapabilities, "constraints.allowedCapabilities", new Set(ROUTER_REQUEST_CAPABILITIES), ROUTER_REQUEST_CAPABILITIES);
  const forbiddenCapabilities = stringList(constraints.forbiddenCapabilities, "constraints.forbiddenCapabilities", new Set([...ROUTER_REQUEST_CAPABILITIES, ...ROUTER_BLOCKED_ACTIONS]), ROUTER_BLOCKED_ACTIONS);
  const conflict = allowedCapabilities.find((capability) => forbiddenCapabilities.includes(capability));
  if (conflict) throw new RouterError("CONFLICTING_CONSTRAINTS", "A capability cannot be both allowed and forbidden.", { safeDetails: { field: "constraints", reason: conflict } });
  if (options.allowActions === true) throw new RouterError("CONFLICTING_CONSTRAINTS", "Actions cannot be enabled in recommendation or simulation mode.", { safeDetails: { field: "options.allowActions" } });

  const suppliedTimestamp = normalizedText(source.timestamp, "timestamp", 64);
  if (suppliedTimestamp && !isValidIsoDateTime(suppliedTimestamp)) throw new RouterError("VALIDATION_FAILED", "timestamp must be a complete ISO 8601 date-time with timezone.");
  const timestamp = suppliedTimestamp ? new Date(suppliedTimestamp).toISOString() : now().toISOString();
  const preferredProvider = optionalId(options.preferredProvider, "options.preferredProvider");
  if (preferredProvider && !ALLOWED_PROVIDER_IDS.includes(preferredProvider)) throw new RouterError("PROVIDER_NOT_ALLOWED", "preferredProvider is not in the provider allowlist.");
  const providerProfile = normalizedText(options.providerProfile, "options.providerProfile", 40);
  if (providerProfile && !ALLOWED_PROVIDER_WORKFLOW_PROFILES.includes(providerProfile)) throw new RouterError("VALIDATION_FAILED", "options.providerProfile is not allowed.");

  return Object.freeze({
    schemaVersion: ROUTER_API_SCHEMA_VERSION,
    requestId: optionalId(source.requestId, "requestId") || `req_${crypto.randomUUID()}`,
    correlationId: optionalId(source.correlationId, "correlationId"),
    timestamp,
    source: requestSource,
    mode,
    intent,
    input: Object.freeze({ type: inputType, content }),
    context: Object.freeze({
      project: normalizedText(context.project, "context.project", MAX_PROJECT_LENGTH),
      contentType: enumValue(context.contentType, "context.contentType", CONTENT_TYPES, "text"),
      contextSize: enumValue(context.contextSize, "context.contextSize", CONTEXT_SIZES, "small"),
      requiresFreshData: boolean(context.requiresFreshData, "context.requiresFreshData", false),
      containsPrivateData: boolean(context.containsPrivateData, "context.containsPrivateData", false),
      requiredTools: Object.freeze(requiredTools(context.requiredTools)),
      client: normalizedText(context.client, "context.client", 80)
    }),
    constraints: Object.freeze({
      allowedCapabilities: Object.freeze(allowedCapabilities),
      forbiddenCapabilities: Object.freeze(forbiddenCapabilities),
      riskLevel: enumValue(constraints.riskLevel, "constraints.riskLevel", RISK_LEVELS, "low"),
      privacyLevel: enumValue(constraints.privacyLevel, "constraints.privacyLevel", PRIVACY_LEVELS, "local-only"),
      costClass: enumValue(constraints.costClass, "constraints.costClass", new Set(PROVIDER_CLASS_LEVELS), "medium"),
      latencyClass: enumValue(constraints.latencyClass, "constraints.latencyClass", new Set(PROVIDER_CLASS_LEVELS), "medium"),
      allowFileProcessing: boolean(constraints.allowFileProcessing, "constraints.allowFileProcessing", false)
    }),
    options: Object.freeze({ preferredProvider, providerProfile, allowActions: false }),
    metadata: Object.freeze({ clientVersion: normalizedText(metadata.clientVersion, "metadata.clientVersion", 40), tags: Object.freeze(tags(metadata.tags)) })
  });
}

export function safeRequestIdentity(input) {
  const requestId = typeof input?.requestId === "string" && input.requestId.length <= ROUTER_REQUEST_ID_MAX_LENGTH && /^[A-Za-z0-9_.:-]+$/.test(input.requestId) ? input.requestId : null;
  const mode = ROUTER_ACTIVE_MODES.includes(input?.mode) ? input.mode : ROUTER_API_DEFAULT_MODE;
  return { requestId, mode };
}
