import { MAX_RESPONSE_LENGTH, ROUTER_VERSION } from "./config.js";
import { ERROR_CODES } from "./policy.js";
import { sanitizeText } from "./jsonl.js";

export function errorPayload(error, requestId = null) {
  const code = ERROR_CODES.includes(error?.code) ? error.code : "INTERNAL_ERROR";
  return { code, message: sanitizeText(error?.message, 300) || "The router could not process the request.", retryable: error?.retryable === true, safeDetails: error?.safeDetails || null, timestamp: new Date().toISOString() };
}

// Safe, bounded provider view for a run response. Reads only the derived plan —
// never prompts, user text or raw provider output.
function projectProvider(run) {
  const plan = run?.providerPlan;
  if (!plan || typeof plan !== "object") return null;
  const runtime = run.providerRuntime && typeof run.providerRuntime === "object" ? run.providerRuntime : {};
  return {
    selectedProviderId: plan.selectedProviderId || null,
    selectedModelId: plan.selectedModelId || null,
    selectedAdapterId: plan.selectedAdapterId || null,
    providerWorkflowProfile: plan.providerWorkflowProfile || null,
    selectionMode: plan.selectionMode || null,
    simulated: plan.simulated === true,
    confidence: plan.confidence || null,
    capabilityMatch: plan.capabilityMatch === true,
    roleMatch: plan.roleMatch === true,
    fallbackReason: plan.fallbackReason ? sanitizeText(plan.fallbackReason, 200) : null,
    reasoning: sanitizeText(plan.reasoning, 240),
    realLocalAdapterUsed: runtime.realLocalAdapterUsed === true,
    alternatives: Array.isArray(plan.alternatives) ? plan.alternatives.slice(0, 3).map((a) => ({ providerId: a.providerId, displayName: sanitizeText(a.displayName, 60), simulated: a.simulated === true })) : [],
    roleAssignments: Array.isArray(plan.roleAssignments) ? plan.roleAssignments.slice(0, 4).map((a) => ({ role: a.role, providerId: a.providerId, simulated: a.simulated === true })) : [],
    warnings: Array.isArray(plan.warnings) ? plan.warnings.map((w) => sanitizeText(w, 200)).filter(Boolean).slice(0, 6) : []
  };
}

function projectSynthesis(run) {
  const s = run?.providerSynthesis;
  if (!s || typeof s !== "object") return null;
  const list = (values) => Array.isArray(values) ? values.map((v) => sanitizeText(v, 300)).filter(Boolean).slice(0, 6) : [];
  return {
    workflowProfile: s.workflowProfile || null,
    providersUsed: Array.isArray(s.providersUsed) ? s.providersUsed.slice(0, 6) : [],
    rolesCompleted: Array.isArray(s.rolesCompleted) ? s.rolesCompleted.slice(0, 4) : [],
    agreements: list(s.agreements),
    disagreements: list(s.disagreements),
    selectedConclusion: sanitizeText(s.selectedConclusion, 400),
    safeSummary: sanitizeText(s.safeSummary, 300),
    warnings: list(s.warnings),
    simulated: s.simulated === true,
    reviewStatus: s.reviewStatus || null
  };
}
export function buildResponse(run, error = null) {
  const fallbackCode = run?.status === "timed_out" ? "STEP_TIMEOUT" : "ADAPTER_FAILED";
  const generatedCode = ERROR_CODES.includes(run?.errorCode) ? run.errorCode : fallbackCode;
  const generated = ["failed", "timed_out"].includes(run?.status) ? errorPayload({ code: generatedCode, message: run.errorSummary || "The router run failed.", retryable: false }) : null;
  const failure = error ? errorPayload(error, run?.requestId) : (run?.error || generated);
  const payload = { schemaVersion: 1, requestId: run?.requestId || null, runId: run?.runId || null, status: run?.status || "failed", success: !failure && run?.status !== "failed" && run?.status !== "timed_out", routePlan: run?.routePlan || null, workflow: run?.workflow || null, provider: projectProvider(run), providerSynthesis: projectSynthesis(run), result: failure ? null : (run?.resultSummary ? { summary: sanitizeText(run.resultSummary, 1_000) } : null), error: failure, warnings: Array.isArray(run?.warnings) ? run.warnings.map((value) => sanitizeText(value, 200)).filter(Boolean).slice(0, 10) : [], timestamps: { createdAt: run?.createdAt || null, startedAt: run?.startedAt || null, finishedAt: run?.finishedAt || null, updatedAt: run?.updatedAt || new Date().toISOString(), durationMs: Number.isFinite(run?.durationMs) ? run.durationMs : null }, routerVersion: ROUTER_VERSION };
  const serialized = JSON.stringify(payload);
  return serialized.length <= MAX_RESPONSE_LENGTH ? payload : { ...payload, routePlan: null, workflow: null, providerSynthesis: null, warnings: ["Response was reduced to its safe size limit."], result: payload.result ? { summary: "Result available but omitted because of response size limit." } : null };
}
