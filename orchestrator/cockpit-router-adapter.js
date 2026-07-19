import crypto from "node:crypto";
import { ROUTER_API_SCHEMA_VERSION } from "./config.js";
import { RouterError } from "./contracts.js";
import { ROUTER_BLOCKED_ACTIONS, ROUTER_REQUEST_CAPABILITIES } from "./policy.js";

const COCKPIT_SCHEMA_VERSION = 1;
const FIELDS = new Set(["schemaVersion", "mode", "execute", "type", "request", "requestedCapability"]);

function compactText(value, maximum) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

export function isCockpitSimulationRequest(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && value.schemaVersion === COCKPIT_SCHEMA_VERSION && value.type === "route.recommendation");
}

export function adaptCockpitSimulationRequest(value, { now = () => new Date(), requestId = null } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouterError("INVALID_REQUEST", "Cockpit simulation request must be an object.");
  const unknown = Object.keys(value).filter((key) => !FIELDS.has(key));
  if (unknown.length) throw new RouterError("VALIDATION_FAILED", "Cockpit simulation request contains unknown fields.", { safeDetails: { field: "request", issues: unknown.slice(0, 8) } });
  if (value.schemaVersion !== COCKPIT_SCHEMA_VERSION) throw new RouterError("UNSUPPORTED_SCHEMA_VERSION", "Unsupported Cockpit simulation schema version.");
  if (value.mode !== "simulate" || value.execute !== false) throw new RouterError("MODE_NOT_ALLOWED", "Cockpit simulation must remain non-executing.");
  if (value.type !== "route.recommendation") throw new RouterError("VALIDATION_FAILED", "Cockpit simulation type is not supported.");
  if ((value.requestedCapability ?? "simulate") !== "simulate") throw new RouterError("CAPABILITY_NOT_ALLOWED", "Cockpit requested capability is not allowed.");
  const content = compactText(value.request, 1000);
  if (content.length < 3) throw new RouterError("VALIDATION_FAILED", "Cockpit simulation request text is required.");
  return Object.freeze({
    schemaVersion: ROUTER_API_SCHEMA_VERSION,
    requestId: requestId || `cockpit_${crypto.randomUUID()}`,
    correlationId: null,
    timestamp: now().toISOString(),
    source: "cockpit",
    mode: "simulation",
    intent: "auto",
    input: Object.freeze({ type: "text", content }),
    context: Object.freeze({ project: "felix-cockpit", contentType: "text", contextSize: "small", requiresFreshData: false, containsPrivateData: false, requiredTools: Object.freeze([]), client: "felix-cockpit" }),
    constraints: Object.freeze({
      allowedCapabilities: Object.freeze([...ROUTER_REQUEST_CAPABILITIES]),
      forbiddenCapabilities: Object.freeze([...ROUTER_BLOCKED_ACTIONS]),
      riskLevel: "low",
      privacyLevel: "local-only",
      costClass: "medium",
      latencyClass: "medium",
      allowFileProcessing: false
    }),
    options: Object.freeze({ preferredProvider: null, providerProfile: null, allowActions: false }),
    metadata: Object.freeze({ clientVersion: "cockpit-adapter-1", tags: Object.freeze(["legacy-simulation-adapter"]) })
  });
}

function cockpitRoute(providerId) {
  return providerId === "codex-local-readonly" ? "codex" : "mock";
}

function cockpitTarget(providerId) {
  if (providerId === "codex-local-readonly") return "Codex";
  return "Cockpit-Simulation";
}

export function adaptRouterResponseForCockpit(response, originalRequest) {
  if (!response || response.status !== "simulated" || response.mode !== "simulation" || response.simulation?.executed !== false) {
    throw new RouterError("SIMULATION_FAILED", "The central router did not return a safe simulation.");
  }
  const providerId = response.recommendation?.recommendedProvider?.providerId || "mock-local";
  return Object.freeze({
    schemaVersion: COCKPIT_SCHEMA_VERSION,
    mode: "simulate",
    label: "Simulation",
    request: compactText(originalRequest?.request, 1000),
    intent: ["code"].includes(response.recommendation?.taskType) || ["cockpit_command", "project_management"].includes(response.recommendation?.route) ? "project_status_summary" : "general_recommendation",
    route: cockpitRoute(providerId),
    target: cockpitTarget(providerId),
    reason: compactText(response.recommendation?.summary, 1000) || "Sichere Router-Empfehlung ohne Ausführung",
    risk: response.risks?.level || "low",
    proposedAction: "Empfehlung anzeigen",
    executionStatus: "never_executed",
    executed: false,
    generatedAt: response.meta.timestamp
  });
}
