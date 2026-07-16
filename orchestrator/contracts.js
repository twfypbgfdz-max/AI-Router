import crypto from "node:crypto";
import { MAX_CONTEXT_LENGTH, MAX_PROJECT_LENGTH, MAX_SOURCE_LENGTH, MAX_TASK_LENGTH } from "./config.js";
import { ALLOWED_ACTION_TYPES, ALLOWED_ADAPTERS, ALLOWED_REQUESTED_MODES, ALLOWED_SOURCES, SCHEMA_VERSION } from "./policy.js";

export class RouterError extends Error {
  constructor(code, message, { retryable = false, safeDetails = null } = {}) { super(message); this.code = code; this.retryable = retryable; this.safeDetails = safeDetails; }
}

function text(value, maximum, code, field, required = false) {
  if (value === undefined || value === null) return required ? (() => { throw new RouterError(code, `${field} is required.`); })() : "";
  if (typeof value !== "string") throw new RouterError("INVALID_REQUEST", `${field} must be a string.`);
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (required && !normalized) throw new RouterError(code, `${field} must be a non-empty string.`);
  if (normalized.length > maximum) throw new RouterError("PAYLOAD_TOO_LARGE", `${field} exceeds its allowed length.`);
  return normalized;
}

export function normalizeRunRequest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RouterError("INVALID_REQUEST", "Request must be a JSON object.");
  const schemaVersion = input.schemaVersion === undefined ? SCHEMA_VERSION : input.schemaVersion;
  if (schemaVersion !== SCHEMA_VERSION) throw new RouterError("UNSUPPORTED_SCHEMA_VERSION", "Unsupported schema version.");
  const task = text(input.task, MAX_TASK_LENGTH, "INVALID_TASK", "task", true);
  const requestedAdapter = input.requestedAdapter ?? input.adapter ?? "mock";
  if (!ALLOWED_ADAPTERS.includes(requestedAdapter)) throw new RouterError("ADAPTER_NOT_ALLOWED", "Unsupported adapter.");
  const requestedMode = input.requestedMode ?? (requestedAdapter === "mock" ? "simulation" : "read-only");
  if (!ALLOWED_REQUESTED_MODES.includes(requestedMode)) throw new RouterError("MODE_NOT_ALLOWED", "Requested mode is not allowed.");
  const source = text(input.source ?? "ui", MAX_SOURCE_LENGTH, "INVALID_REQUEST", "source");
  if (!ALLOWED_SOURCES.includes(source)) throw new RouterError("INVALID_REQUEST", "Source is not allowed.");
  const actionType = input.options?.actionType ?? "simulation";
  if (!ALLOWED_ACTION_TYPES.includes(actionType)) throw new RouterError("ACTION_NOT_ALLOWED", "Action type is not allowed.");
  return Object.freeze({ schemaVersion, requestId: text(input.requestId, 96, "INVALID_REQUEST", "requestId") || `req_${crypto.randomUUID()}`, task, project: text(input.project, MAX_PROJECT_LENGTH, "INVALID_REQUEST", "project"), requestedMode, requestedAdapter, source, context: text(input.context, MAX_CONTEXT_LENGTH, "INVALID_REQUEST", "context"), options: Object.freeze({ actionType, simulationMode: input.options?.simulationMode ?? input.simulationMode }), createdAt: new Date().toISOString() });
}
