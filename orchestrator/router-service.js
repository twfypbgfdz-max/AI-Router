import { ROUTER_API_DEFAULT_MODE, ROUTER_API_SCHEMA_VERSION, ROUTER_VERSION } from "./config.js";
import { RouterError } from "./contracts.js";
import { countSimulationActions, evaluateAction, listPublicActions } from "./action-registry.js";
import { normalizeRouterRequest, safeRequestIdentity } from "./router-contract.js";
import { buildRouterBlocked, buildRouterFailure, buildRouterSuccess } from "./router-response.js";
import { createRouterDecision, ROUTER_ROUTES } from "./routing-engine.js";

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
        proposedAction: data.action,
        allowlistResult: data.allowlistResult,
        riskLevel: data.riskLevel,
        errorCode: data.errorCode
      }
    });
  } catch { /* logging must never break routing */ }
}

export async function processRouterRequest(input, { eventLogger = null, clock = Date.now } = {}) {
  const startedAt = clock();
  let request = null;
  let decision = null;
  let response;
  try {
    request = normalizeRouterRequest(input);
    decision = createRouterDecision(request.input.content);
    if (decision.route === "unsupported") throw new RouterError("ROUTE_NOT_FOUND", "No supported route was found for the request.");
    if (request.mode === "execute") throw new RouterError("EXECUTION_DISABLED", "Execute mode is disabled for the router API.");
    const durationMs = Math.max(0, clock() - startedAt);
    response = decision.route === "blocked"
      ? buildRouterBlocked({ request, decision, durationMs })
      : buildRouterSuccess({ request, decision, policy: evaluateAction(decision.proposedAction, request.mode), durationMs });
  } catch (error) {
    const identity = request || safeRequestIdentity(input);
    response = buildRouterFailure(error, { requestId: identity.requestId, mode: identity.mode, decision, durationMs: Math.max(0, clock() - startedAt) });
  }
  await logOutcome(eventLogger, {
    requestId: response.requestId,
    status: response.status,
    durationMs: response.meta.durationMs,
    source: request?.source || null,
    mode: response.mode,
    route: response.route?.name || null,
    action: response.decision?.action || null,
    allowlistResult: response.decision?.allowed === true ? "allowed" : "blocked",
    riskLevel: response.decision?.riskLevel || null,
    errorCode: response.error?.code || null
  });
  return response;
}

export function routerStatus() {
  return {
    schemaVersion: ROUTER_API_SCHEMA_VERSION,
    routerVersion: ROUTER_VERSION,
    serviceStatus: "operational",
    supportedSchemaVersions: [ROUTER_API_SCHEMA_VERSION],
    defaultMode: ROUTER_API_DEFAULT_MODE,
    enabledRoutes: [...ROUTER_ROUTES],
    allowedActionCount: countSimulationActions(),
    executionEnabled: false
  };
}

export function routerActions() {
  return { schemaVersion: ROUTER_API_SCHEMA_VERSION, actions: listPublicActions() };
}
