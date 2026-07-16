import { MAX_RESPONSE_LENGTH, ROUTER_VERSION } from "./config.js";
import { ERROR_CODES } from "./policy.js";
import { sanitizeText } from "./jsonl.js";

export function errorPayload(error, requestId = null) {
  const code = ERROR_CODES.includes(error?.code) ? error.code : "INTERNAL_ERROR";
  return { code, message: sanitizeText(error?.message, 300) || "The router could not process the request.", retryable: error?.retryable === true, safeDetails: error?.safeDetails || null, timestamp: new Date().toISOString() };
}
export function buildResponse(run, error = null) {
  const generated = ["failed", "timed_out"].includes(run?.status) ? errorPayload({ code: run.status === "timed_out" ? "STEP_TIMEOUT" : "ADAPTER_FAILED", message: run.errorSummary || "The router run failed.", retryable: false }) : null;
  const failure = error ? errorPayload(error, run?.requestId) : (run?.error || generated);
  const payload = { schemaVersion: 1, requestId: run?.requestId || null, runId: run?.runId || null, status: run?.status || "failed", success: !failure && run?.status !== "failed" && run?.status !== "timed_out", routePlan: run?.routePlan || null, workflow: run?.workflow || null, result: failure ? null : (run?.resultSummary ? { summary: sanitizeText(run.resultSummary, 1_000) } : null), error: failure, warnings: Array.isArray(run?.warnings) ? run.warnings.map((value) => sanitizeText(value, 200)).filter(Boolean).slice(0, 10) : [], timestamps: { createdAt: run?.createdAt || null, startedAt: run?.startedAt || null, finishedAt: run?.finishedAt || null, updatedAt: run?.updatedAt || new Date().toISOString() }, routerVersion: ROUTER_VERSION };
  const serialized = JSON.stringify(payload);
  return serialized.length <= MAX_RESPONSE_LENGTH ? payload : { ...payload, routePlan: null, workflow: null, warnings: ["Response was reduced to its safe size limit."], result: payload.result ? { summary: "Result available but omitted because of response size limit." } : null };
}
