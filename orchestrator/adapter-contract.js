import { ALLOWED_ACTION_TYPES, ALLOWED_RUN_STATUSES } from "./policy.js";

export const ADAPTER_CONTRACT_VERSION = 1;

export function buildAdapterInput({ adapter, requestId, runId, taskType, safeInstruction, workingDirectory, timeoutMs, maxOutputBytes, retryAttempt = 0, abortSignal = null } = {}) {
  if (typeof adapter !== "string" || !adapter) throw new Error("Adapter input requires an adapter name.");
  if (typeof requestId !== "string" || !requestId) throw new Error("Adapter input requires a requestId.");
  if (typeof runId !== "string" || !runId) throw new Error("Adapter input requires a runId.");
  if (!ALLOWED_ACTION_TYPES.includes(taskType)) throw new Error("Adapter input requires a known taskType.");
  if (typeof safeInstruction !== "string" || !safeInstruction.trim()) throw new Error("Adapter input requires a safe instruction.");
  if (typeof workingDirectory !== "string" || !workingDirectory) throw new Error("Adapter input requires a workingDirectory.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Adapter input requires a positive timeoutMs.");
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) throw new Error("Adapter input requires a positive maxOutputBytes.");
  if (!Number.isInteger(retryAttempt) || retryAttempt < 0) throw new Error("Adapter input requires a non-negative retryAttempt.");
  return Object.freeze({ adapter, requestId, runId, taskType, safeInstruction, workingDirectory, timeoutMs, maxOutputBytes, retryAttempt, abortSignal: abortSignal || null });
}

export function buildAdapterOutput({ adapter, status, success, exitCode = null, startedAt = null, finishedAt = null, retryable = false, result = null, error = null, warnings = [], safeMetadata = {} } = {}) {
  if (typeof adapter !== "string" || !adapter) throw new Error("Adapter output requires an adapter name.");
  if (!ALLOWED_RUN_STATUSES.includes(status)) throw new Error("Adapter output requires a known status.");
  const durationMs = startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null;
  return Object.freeze({
    adapter,
    status,
    success: success === true,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    startedAt: startedAt || null,
    finishedAt: finishedAt || null,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    retryable: retryable === true,
    result: result && typeof result === "object" ? Object.freeze({ ...result }) : null,
    error: error && typeof error === "object" ? Object.freeze({ ...error }) : null,
    warnings: Array.isArray(warnings) ? Object.freeze([...warnings]) : Object.freeze([]),
    safeMetadata: safeMetadata && typeof safeMetadata === "object" ? Object.freeze({ ...safeMetadata }) : Object.freeze({})
  });
}
