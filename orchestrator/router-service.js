import { ROUTER_API_DEFAULT_MODE, ROUTER_API_SCHEMA_VERSION, ROUTER_VERSION } from "./config.js";
import { RouterError } from "./contracts.js";
import { countSimulationActions, listPublicActions } from "./action-registry.js";
import { adaptCockpitSimulationRequest, adaptRouterResponseForCockpit, isCockpitSimulationRequest } from "./cockpit-router-adapter.js";
import { normalizeRouterRequest, safeRequestIdentity } from "./router-contract.js";
import { buildRouterBlocked, buildRouterFailure, buildRouterSuccess } from "./router-response.js";
import { createRoutePlan, createRouterDecision, ROUTER_ROUTES } from "./routing-engine.js";
import { selectProvider } from "./provider-selection.js";
import { providerRegistry } from "./provider-registry.js";
import { ROUTER_ACTIVE_MODES, ROUTER_BLOCKED_ACTIONS, ROUTER_FUTURE_MODES } from "./policy.js";

const TASK_CAPABILITY = Object.freeze({
  code: "coding", research: "research-planning", planning: "planning", writing: "writing",
  obsidian: "summarization", social_media: "writing", learning: "summarization",
  career: "writing", finance: "analysis", everyday: "planning", unknown: "analysis"
});
const CLASS_INDEX = Object.freeze({ low: 0, medium: 1, high: 2 });
const CONTEXT_INDEX = Object.freeze({ small: 0, medium: 1, large: 2 });

async function logOutcome(eventLogger, data) {
  if (!eventLogger?.log) return;
  try {
    await eventLogger.log({
      event: "router_request_completed",
      requestId: data.requestId,
      status: data.status,
      durationMs: data.durationMs,
      safeMetadata: {
        source: data.source,
        mode: data.mode,
        route: data.route,
        recommendedProviderId: data.recommendedProviderId,
        riskLevel: data.riskLevel,
        errorCode: data.errorCode,
        executed: false
      }
    });
  } catch { /* logging must never break routing */ }
}

function requiredCapabilities(request, routePlan) {
  const capabilities = [TASK_CAPABILITY[routePlan.taskType] || "analysis"];
  if (request.context.contentType === "code" && !capabilities.includes("coding")) capabilities.push("coding");
  if (["file", "mixed"].includes(request.context.contentType)) capabilities.push("file-analysis");
  if (["image", "mixed"].includes(request.context.contentType)) capabilities.push("image-analysis");
  if (request.context.requiredTools.includes("repository-read") && !capabilities.includes("analysis")) capabilities.push("analysis");
  if (request.context.requiredTools.includes("file-read") && !capabilities.includes("file-analysis")) capabilities.push("file-analysis");
  if (request.context.requiredTools.includes("image-input") && !capabilities.includes("image-analysis")) capabilities.push("image-analysis");
  return capabilities;
}

function validateSafetyConstraints(request, routePlan, capabilities) {
  if (request.context.requiresFreshData || request.context.requiredTools.includes("web-research")) throw new RouterError("NO_SAFE_ROUTE", "No fresh-data route is enabled without external provider access.", { safeDetails: { reason: "fresh_data_unavailable" } });
  if ((["file", "mixed"].includes(request.context.contentType) || request.context.requiredTools.includes("file-read")) && !request.constraints.allowFileProcessing) {
    throw new RouterError("CAPABILITY_NOT_ALLOWED", "File analysis was requested but file processing is disabled.", { safeDetails: { field: "constraints.allowFileProcessing" } });
  }
  const unavailable = capabilities.find((capability) => !request.constraints.allowedCapabilities.includes(capability) || request.constraints.forbiddenCapabilities.includes(capability));
  if (unavailable) throw new RouterError("CAPABILITY_NOT_ALLOWED", "A required capability is not allowed by the request constraints.", { safeDetails: { field: "constraints", reason: unavailable } });
  const assessedRisk = routePlan.risk === "R0" || routePlan.risk === "R1" ? "low" : routePlan.risk === "R2" ? "medium" : "high";
  if (CLASS_INDEX[assessedRisk] > CLASS_INDEX[request.constraints.riskLevel]) {
    throw new RouterError("CONFLICTING_CONSTRAINTS", "The assessed risk exceeds the requested risk limit.", { safeDetails: { field: "constraints.riskLevel", expected: assessedRisk } });
  }
}

function providerMeetsConstraints(provider, request, capabilities) {
  if (!provider || !provider.enabled || provider.availability !== "available") return false;
  if (!capabilities.every((capability) => provider.capabilities.includes(capability))) return false;
  if (CLASS_INDEX[provider.costClass] > CLASS_INDEX[request.constraints.costClass]) return false;
  if (CLASS_INDEX[provider.latencyClass] > CLASS_INDEX[request.constraints.latencyClass]) return false;
  const requiredContext = CONTEXT_INDEX[request.context.contextSize];
  if (CLASS_INDEX[provider.contextClass] < requiredContext) return false;
  return true;
}

function recommendedProvider(selection, request, capabilities) {
  const preferred = request.options.preferredProvider ? providerRegistry.get(request.options.preferredProvider) : null;
  if (providerMeetsConstraints(preferred, request, capabilities)) return preferred;
  for (const alternative of selection.alternatives) {
    const provider = providerRegistry.get(alternative.providerId);
    if (providerMeetsConstraints(provider, request, capabilities)) return provider;
  }
  const mock = providerRegistry.get("mock-local");
  if (providerMeetsConstraints(mock, request, capabilities)) return mock;
  throw new RouterError("NO_SAFE_ROUTE", "No allowlisted provider profile satisfies the request constraints.");
}

async function processCanonicalRequest(rawInput, { eventLogger, clock, now }) {
  const startedAt = clock();
  let request = null;
  let decision = null;
  let routePlan = null;
  let response;
  try {
    request = normalizeRouterRequest(rawInput, { now });
    decision = createRouterDecision(request.input.content);
    routePlan = createRoutePlan(request.input.content);
    if (decision.route === "unsupported") throw new RouterError("NO_SAFE_ROUTE", "No safe route was found for the request.");
    const capabilities = requiredCapabilities(request, routePlan);
    if (decision.route === "blocked") {
      response = buildRouterBlocked({ request, decision, routePlan, requiredCapabilities: capabilities, durationMs: Math.max(0, clock() - startedAt), timestamp: now().toISOString() });
    } else {
      validateSafetyConstraints(request, routePlan, capabilities);
      const selection = selectProvider({
        routePlan,
        request: { requestedProvider: request.options.preferredProvider, options: { providerProfile: request.options.providerProfile } }
      });
      const recommended = recommendedProvider(selection, request, capabilities);
      response = buildRouterSuccess({ request, decision, routePlan, selection, recommendedProvider: recommended, requiredCapabilities: capabilities, durationMs: Math.max(0, clock() - startedAt), timestamp: now().toISOString() });
    }
  } catch (error) {
    const identity = request || safeRequestIdentity(rawInput);
    response = buildRouterFailure(error, { requestId: identity.requestId, mode: identity.mode, durationMs: Math.max(0, clock() - startedAt), timestamp: now().toISOString() });
  }
  await logOutcome(eventLogger, {
    requestId: response.requestId,
    status: response.status,
    durationMs: response.meta.durationMs,
    source: request?.source || null,
    mode: response.mode,
    route: response.recommendation?.route || decision?.route || null,
    recommendedProviderId: response.recommendation?.recommendedProvider?.providerId || null,
    riskLevel: response.risks?.level || null,
    errorCode: response.error?.code || null
  });
  return response;
}

export async function processRouterRequest(input, { eventLogger = null, clock = Date.now, now = () => new Date() } = {}) {
  if (!isCockpitSimulationRequest(input)) return processCanonicalRequest(input, { eventLogger, clock, now });
  let canonical;
  try {
    canonical = adaptCockpitSimulationRequest(input, { now });
  } catch (error) {
    return buildRouterFailure(error, { mode: "simulation", timestamp: now().toISOString() });
  }
  const response = await processCanonicalRequest(canonical, { eventLogger, clock, now });
  if (response.status !== "simulated") return response;
  try { return adaptRouterResponseForCockpit(response, input); }
  catch (error) { return buildRouterFailure(error, { requestId: response.requestId, mode: "simulation", timestamp: now().toISOString() }); }
}

export function routerStatus() {
  return {
    schemaVersion: ROUTER_API_SCHEMA_VERSION,
    routerVersion: ROUTER_VERSION,
    serviceStatus: "operational",
    supportedSchemaVersions: [ROUTER_API_SCHEMA_VERSION],
    defaultMode: ROUTER_API_DEFAULT_MODE,
    activeModes: [...ROUTER_ACTIVE_MODES],
    futureModes: [...ROUTER_FUTURE_MODES],
    responseStatuses: ["recommended", "simulated", "rejected", "failed"],
    enabledRoutes: [...ROUTER_ROUTES],
    allowedActionCount: countSimulationActions(),
    blockedActions: [...ROUTER_BLOCKED_ACTIONS],
    executionEnabled: false,
    externalProvidersEnabled: false,
    persistentJobsEnabled: false
  };
}

export function routerActions() {
  return { schemaVersion: ROUTER_API_SCHEMA_VERSION, actions: listPublicActions() };
}
