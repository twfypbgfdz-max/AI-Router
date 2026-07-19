import { ROUTER_API_DEFAULT_MODE, ROUTER_API_SCHEMA_VERSION, ROUTER_VERSION } from "./config.js";
import { ERROR_CODES, ROUTER_BLOCKED_ACTIONS } from "./policy.js";
import { sanitizeText } from "./jsonl.js";

const HTTP_STATUS_BY_ERROR = Object.freeze({
  INVALID_REQUEST: 400,
  UNSUPPORTED_SCHEMA_VERSION: 400,
  VALIDATION_FAILED: 422,
  SOURCE_NOT_ALLOWED: 422,
  MODE_NOT_ALLOWED: 422,
  CAPABILITY_NOT_ALLOWED: 403,
  CONFLICTING_CONSTRAINTS: 422,
  NO_SAFE_ROUTE: 422,
  SIMULATION_FAILED: 500,
  INTERNAL_VALIDATION_FAILED: 500,
  ROUTE_NOT_FOUND: 422,
  ACTION_NOT_ALLOWLISTED: 403,
  EXECUTION_DISABLED: 403,
  PROVIDER_NOT_FOUND: 422,
  PROVIDER_NOT_ALLOWED: 403,
  PROVIDER_DISABLED: 422,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_CAPABILITY_MISMATCH: 422,
  PROVIDER_TASK_NOT_SUPPORTED: 422,
  PROVIDER_ROLE_NOT_SUPPORTED: 422,
  ORIGIN_NOT_ALLOWED: 403,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_ERROR: 500,
  UNAVAILABLE: 503,
  TIMEOUT: 504
});
const SAFE_DETAIL_KEYS = new Set(["field", "reason", "expected", "limit", "supportedVersions", "validation", "issues"]);

function safePublicText(value, maximum = 300) {
  const sanitized = sanitizeText(value, maximum);
  if (!sanitized) return null;
  return sanitized
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\s]*/g, "[REDACTED_PATH]")
    .replace(/file:\/\/\/[^\s]+/gi, "[REDACTED_PATH]");
}

function projectSafeDetails(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return null;
  const projected = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_DETAIL_KEYS.has(key)) continue;
    if (typeof item === "string") {
      const text = safePublicText(item, 160);
      if (text) projected[key] = text;
    } else if (typeof item === "number" && Number.isFinite(item)) projected[key] = item;
    else if (Array.isArray(item)) projected[key] = item.filter((entry) => typeof entry === "string").map((entry) => safePublicText(entry, 120)).filter(Boolean).slice(0, 8);
    else {
      const nested = projectSafeDetails(item, depth + 1);
      if (nested) projected[key] = nested;
    }
  }
  return Object.keys(projected).length ? projected : null;
}

function base({ requestId = null, mode = ROUTER_API_DEFAULT_MODE, status, durationMs = 0, timestamp = new Date().toISOString() }) {
  return {
    schemaVersion: ROUTER_API_SCHEMA_VERSION,
    requestId,
    routerVersion: ROUTER_VERSION,
    status,
    mode,
    recommendation: null,
    simulation: null,
    risks: { level: "unknown", reasonCodes: [] },
    constraints: null,
    allowedNextSteps: [],
    blockedActions: [...ROUTER_BLOCKED_ACTIONS],
    error: null,
    meta: { durationMs, timestamp, stateModelVersion: "1.0", executionEnabled: false }
  };
}

function riskLevel(routePlan) {
  if (routePlan.risk === "R0" || routePlan.risk === "R1") return "low";
  if (routePlan.risk === "R2") return "medium";
  return "high";
}

function constraintsView(request, requiredCapabilities) {
  return {
    requiredCapabilities: [...requiredCapabilities],
    requiredTools: [...request.context.requiredTools],
    allowedCapabilities: [...request.constraints.allowedCapabilities],
    forbiddenCapabilities: [...request.constraints.forbiddenCapabilities],
    privacyLevel: request.constraints.privacyLevel,
    costClass: request.constraints.costClass,
    latencyClass: request.constraints.latencyClass,
    fileProcessingAllowed: request.constraints.allowFileProcessing
  };
}

function recommendationView({ request, decision, routePlan, selection, recommendedProvider, requiredCapabilities }) {
  return {
    intent: request.intent,
    detectedIntent: routePlan.taskType,
    taskType: routePlan.taskType,
    complexity: routePlan.complexity,
    route: decision.route,
    title: "Sichere Router-Empfehlung",
    summary: decision.reason,
    reasonCodes: [`ROUTE_${decision.route.toUpperCase()}`, `TASK_${routePlan.taskType.toUpperCase()}`, "DETERMINISTIC_PROVIDER_SELECTION"],
    evidence: [
      { field: "routing.taskType", value: routePlan.taskType },
      { field: "routing.requiredCapabilities", value: [...requiredCapabilities] },
      { field: "routing.contextType", value: request.context.contentType },
      { field: "routing.freshnessRequired", value: request.context.requiresFreshData }
    ],
    confidence: decision.confidence,
    recommendedProvider: {
      providerId: recommendedProvider.providerId,
      displayName: recommendedProvider.displayName,
      simulatedProfile: recommendedProvider.simulated === true,
      externalCallAllowed: false
    },
    mockFallback: {
      providerId: "mock-local",
      adapterId: "mock",
      available: true,
      executed: false
    }
  };
}

function simulationView({ request, selection, routePlan, requiredCapabilities }) {
  return {
    providerId: "mock-local",
    adapterId: "mock",
    providerWorkflowProfile: selection.providerWorkflowProfile,
    plannedSteps: selection.roleAssignments.map((step, index) => ({ index: index + 1, role: step.role, providerId: step.providerId, simulated: true })),
    requiredCapabilities: [...requiredCapabilities],
    requiredTools: [...request.context.requiredTools],
    allowedActions: ["result.display"],
    blockedActions: [...ROUTER_BLOCKED_ACTIONS],
    approvalWouldBeRequired: routePlan.approvalRequired === true,
    futureMode: routePlan.approvalRequired === true ? "approval_required" : null,
    expectedResultFormat: "structured-router-response-v2",
    executionStatus: "never_executed",
    executed: false
  };
}

export function routerHttpStatus(errorCode) {
  return HTTP_STATUS_BY_ERROR[errorCode] || 500;
}

export function buildRouterSuccess({ request, decision, routePlan, selection, recommendedProvider, requiredCapabilities, durationMs, timestamp = new Date().toISOString() }) {
  const response = base({ requestId: request.requestId, mode: request.mode, status: request.mode === "simulation" ? "simulated" : "recommended", durationMs, timestamp });
  response.recommendation = recommendationView({ request, decision, routePlan, selection, recommendedProvider, requiredCapabilities });
  response.simulation = request.mode === "simulation" ? simulationView({ request, selection, routePlan, requiredCapabilities }) : null;
  response.risks = { level: riskLevel(routePlan), reasonCodes: routePlan.approvalRequired ? ["FUTURE_APPROVAL_REQUIRED", "EXECUTION_DISABLED"] : ["NO_EXECUTION_PERMITTED"] };
  response.constraints = constraintsView(request, requiredCapabilities);
  response.allowedNextSteps = request.mode === "recommendation" ? ["simulation.request", "result.display"] : ["result.display"];
  return response;
}

export function buildRouterBlocked({ request, decision, routePlan, requiredCapabilities = [], durationMs, timestamp = new Date().toISOString() }) {
  const response = base({ requestId: request.requestId, mode: request.mode, status: "rejected", durationMs, timestamp });
  response.risks = { level: "high", reasonCodes: ["RISKY_ACTION_DETECTED", "EXECUTION_DISABLED"] };
  response.constraints = constraintsView(request, requiredCapabilities);
  response.error = { code: "CAPABILITY_NOT_ALLOWED", message: safePublicText(decision.reason, 300), retryable: false, details: { reason: routePlan?.risk || "R4" } };
  return response;
}

export function buildRouterFailure(error, { requestId = null, mode = ROUTER_API_DEFAULT_MODE, durationMs = 0, timestamp = new Date().toISOString() } = {}) {
  const code = ERROR_CODES.includes(error?.code) ? error.code : "INTERNAL_ERROR";
  const internal = ["INTERNAL_ERROR", "INTERNAL_VALIDATION_FAILED", "SIMULATION_FAILED"].includes(code);
  const response = base({ requestId, mode, status: "failed", durationMs, timestamp });
  response.error = {
    code,
    message: internal ? "The router could not process the request." : (safePublicText(error?.message, 300) || "The router could not process the request."),
    retryable: error?.retryable === true,
    details: internal ? null : projectSafeDetails(error?.safeDetails)
  };
  return response;
}
