import crypto from "node:crypto";
import { MAX_CONTEXT_LENGTH, MAX_PROJECT_LENGTH, MAX_SOURCE_LENGTH, MAX_TASK_LENGTH } from "./config.js";
import { ALLOWED_ACTION_TYPES, ALLOWED_ADAPTERS, ALLOWED_PROVIDER_IDS, ALLOWED_PROVIDER_WORKFLOW_PROFILES, ALLOWED_REQUESTED_MODES, ALLOWED_SOURCES, SCHEMA_VERSION } from "./policy.js";
import { isValidSessionId } from "./session/session-store.js";

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
  // v0.13: optional manual provider selection. Normalized, size-bounded and
  // checked against the central registry allowlist — never a free-form name.
  const rawProvider = input.requestedProvider ?? input.options?.requestedProvider;
  let requestedProvider = null;
  if (rawProvider !== undefined && rawProvider !== null && rawProvider !== "") {
    if (typeof rawProvider !== "string") throw new RouterError("INVALID_REQUEST", "requestedProvider must be a string.");
    const normalizedProvider = rawProvider.normalize("NFKC").trim().slice(0, 40);
    if (!ALLOWED_PROVIDER_IDS.includes(normalizedProvider)) throw new RouterError("PROVIDER_NOT_ALLOWED", "requestedProvider is not in the central allowlist.");
    requestedProvider = normalizedProvider;
  }
  // v0.13: optional provider workflow profile. Fixed allowlist only.
  const rawProfile = input.providerProfile ?? input.options?.providerProfile;
  let providerProfile = null;
  if (rawProfile !== undefined && rawProfile !== null && rawProfile !== "") {
    if (typeof rawProfile !== "string" || !ALLOWED_PROVIDER_WORKFLOW_PROFILES.includes(rawProfile)) throw new RouterError("INVALID_REQUEST", "providerProfile is not allowed.");
    providerProfile = rawProfile;
  }
  // J1.2: optional correlation to a Jarvis session (see session/session-store.js).
  // Same fail-closed-but-never-hard-fails posture as that store's own
  // isValidSessionId - an invalid/malformed value is silently treated as "no
  // session" rather than rejected, so every existing caller that never sends
  // it keeps working unchanged.
  const sessionId = typeof input.sessionId === "string" && isValidSessionId(input.sessionId) ? input.sessionId : null;
  return Object.freeze({ schemaVersion, requestId: text(input.requestId, 96, "INVALID_REQUEST", "requestId") || `req_${crypto.randomUUID()}`, task, project: text(input.project, MAX_PROJECT_LENGTH, "INVALID_REQUEST", "project"), requestedMode, requestedAdapter, requestedProvider, source, context: text(input.context, MAX_CONTEXT_LENGTH, "INVALID_REQUEST", "context"), options: Object.freeze({ actionType, simulationMode: input.options?.simulationMode ?? input.simulationMode, providerProfile }), sessionId, createdAt: new Date().toISOString() });
}
