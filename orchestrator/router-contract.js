import crypto from "node:crypto";
import { MAX_PROJECT_LENGTH, MAX_SOURCE_LENGTH, MAX_TASK_LENGTH, ROUTER_API_DEFAULT_MODE, ROUTER_API_SCHEMA_VERSION, ROUTER_REQUEST_ID_MAX_LENGTH } from "./config.js";
import { RouterError } from "./contracts.js";

const SOURCES = new Set(["cockpit", "ui", "api", "local"]);
const MODES = new Set(["simulate", "execute"]);
const INPUT_TYPES = new Set(["text"]);
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

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

function normalizedText(value, field, maximum, { required = false, fallback = null } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new RouterError("VALIDATION_FAILED", `${field} is required.`);
    return fallback;
  }
  if (typeof value !== "string") throw new RouterError("VALIDATION_FAILED", `${field} must be a string.`);
  const result = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (required && !result) throw new RouterError("VALIDATION_FAILED", `${field} must not be empty.`);
  if (result.length > maximum) throw new RouterError("PAYLOAD_TOO_LARGE", `${field} exceeds its allowed length.`);
  return result || fallback;
}

function optionalId(value, field, fallback = null, maximum = ROUTER_REQUEST_ID_MAX_LENGTH) {
  const result = normalizedText(value, field, maximum, { fallback });
  if (result !== null && !/^[A-Za-z0-9_.:-]+$/.test(result)) throw new RouterError("VALIDATION_FAILED", `${field} contains unsupported characters.`);
  return result;
}

export function normalizeRouterRequest(input, { now = () => new Date() } = {}) {
  const source = object(input, "request", null);
  if (!source) throw new RouterError("INVALID_REQUEST", "Request must be a JSON object.");
  if (source.schemaVersion !== ROUTER_API_SCHEMA_VERSION) throw new RouterError("UNSUPPORTED_SCHEMA_VERSION", "Unsupported schema version.");

  const requestSource = normalizedText(source.source, "source", MAX_SOURCE_LENGTH, { required: true });
  if (!SOURCES.has(requestSource)) throw new RouterError("VALIDATION_FAILED", "source is not allowed.");
  const mode = normalizedText(source.mode, "mode", 16, { fallback: ROUTER_API_DEFAULT_MODE });
  if (!MODES.has(mode)) throw new RouterError("VALIDATION_FAILED", "mode must be simulate or execute.");

  const inputData = object(source.input, "input", null);
  if (!inputData) throw new RouterError("VALIDATION_FAILED", "input is required.");
  const inputType = normalizedText(inputData.type, "input.type", 20, { required: true });
  if (!INPUT_TYPES.has(inputType)) throw new RouterError("VALIDATION_FAILED", "input.type is not supported.");
  const content = normalizedText(inputData.content, "input.content", MAX_TASK_LENGTH, { required: true });

  const context = object(source.context, "context");
  const options = object(source.options, "options");
  if (options.allowActions !== undefined && typeof options.allowActions !== "boolean") throw new RouterError("VALIDATION_FAILED", "options.allowActions must be a boolean.");

  const suppliedTimestamp = normalizedText(source.timestamp, "timestamp", 64);
  if (suppliedTimestamp && !isValidIsoDateTime(suppliedTimestamp)) throw new RouterError("VALIDATION_FAILED", "timestamp must be a complete ISO 8601 date-time with timezone.");
  const timestamp = suppliedTimestamp ? new Date(suppliedTimestamp).toISOString() : now().toISOString();

  return Object.freeze({
    schemaVersion: ROUTER_API_SCHEMA_VERSION,
    requestId: optionalId(source.requestId, "requestId") || `req_${crypto.randomUUID()}`,
    timestamp,
    source: requestSource,
    mode,
    input: Object.freeze({ type: inputType, content }),
    context: Object.freeze({
      userId: optionalId(context.userId, "context.userId", "local-user"),
      sessionId: optionalId(context.sessionId, "context.sessionId"),
      project: normalizedText(context.project, "context.project", MAX_PROJECT_LENGTH)
    }),
    options: Object.freeze({
      preferredProvider: optionalId(options.preferredProvider, "options.preferredProvider"),
      allowActions: options.allowActions === true
    })
  });
}

export function safeRequestIdentity(input) {
  const requestId = typeof input?.requestId === "string" && input.requestId.length <= ROUTER_REQUEST_ID_MAX_LENGTH && /^[A-Za-z0-9_.:-]+$/.test(input.requestId) ? input.requestId : null;
  const mode = MODES.has(input?.mode) ? input.mode : ROUTER_API_DEFAULT_MODE;
  return { requestId, mode };
}
