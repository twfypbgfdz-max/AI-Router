import { createProviderContract, isValidProviderContract, projectPublicProvider } from "./provider-contract.js";
import { ALLOWED_MODEL_IDS, ALLOWED_PROVIDER_IDS, ALLOWED_ROLES, ALLOWED_CAPABILITIES, PROVIDER_CLASS_LEVELS } from "./policy.js";
import { TASK_TYPES } from "./routing-engine.js";

const ALL_TASK_TYPES = Object.freeze([...TASK_TYPES]);
const ALL_ROLES = Object.freeze([...ALLOWED_ROLES]);

// Static provider definitions. This is the single authoritative source. Every
// entry is validated through createProviderContract before it is trusted.
// Only mock-local and codex-local-readonly are executable; the rest are LOCAL
// SIMULATIONS of an external vendor profile — no API, no network, no keys.
export const PROVIDER_DEFINITIONS = Object.freeze([
  {
    providerId: "mock-local", displayName: "Mock lokal", providerType: "mock",
    executionMode: "simulation", adapterId: "mock", modelId: "mock-deterministic-v1",
    capabilities: [...ALLOWED_CAPABILITIES],
    supportedTaskTypes: ALL_TASK_TYPES, supportedRoles: ALL_ROLES,
    availability: "available", enabled: true, simulated: true, external: false,
    requiresNetwork: false, requiresCredentials: false,
    riskClass: "low", priority: 100, costClass: "low", latencyClass: "low", contextClass: "medium", outputClass: "medium",
    safeMetadata: { note: "deterministic baseline" }
  },
  {
    providerId: "codex-local-readonly", displayName: "Codex lokal read-only", providerType: "codex",
    executionMode: "local-read-only", adapterId: "codex-cli-readonly", modelId: "codex-local-readonly",
    capabilities: ["analysis", "coding", "debugging", "review", "architecture"],
    supportedTaskTypes: ["code", "planning", "research", "unknown"], supportedRoles: ["executor", "reviewer"],
    availability: "available", enabled: true, simulated: false, external: false,
    requiresNetwork: false, requiresCredentials: false,
    riskClass: "low", priority: 90, costClass: "low", latencyClass: "medium", contextClass: "high", outputClass: "medium",
    safeMetadata: { mode: "read-only" }
  },
  {
    providerId: "claude-simulated", displayName: "Claude-Profil (lokale Simulation)", providerType: "claude",
    executionMode: "simulation", adapterId: "mock", modelId: "claude-general-sim",
    capabilities: ["planning", "architecture", "analysis", "review", "synthesis", "writing"],
    supportedTaskTypes: ALL_TASK_TYPES, supportedRoles: ALL_ROLES,
    availability: "available", enabled: true, simulated: true, external: true,
    requiresNetwork: false, requiresCredentials: false,
    riskClass: "low", priority: 80, costClass: "medium", latencyClass: "medium", contextClass: "high", outputClass: "high",
    safeMetadata: { focus: "planning-architecture" }
  },
  {
    providerId: "openai-simulated", displayName: "OpenAI-Profil (lokale Simulation)", providerType: "openai",
    executionMode: "simulation", adapterId: "mock", modelId: "openai-general-sim",
    capabilities: ["coding", "analysis", "planning", "summarization", "synthesis", "writing", "classification"],
    supportedTaskTypes: ALL_TASK_TYPES, supportedRoles: ALL_ROLES,
    availability: "available", enabled: true, simulated: true, external: true,
    requiresNetwork: false, requiresCredentials: false,
    riskClass: "low", priority: 75, costClass: "medium", latencyClass: "low", contextClass: "medium", outputClass: "high",
    safeMetadata: { focus: "general-implementation" }
  },
  {
    providerId: "gemini-simulated", displayName: "Gemini-Profil (lokale Simulation)", providerType: "gemini",
    executionMode: "simulation", adapterId: "mock", modelId: "gemini-research-sim",
    capabilities: ["research-planning", "analysis", "summarization", "classification", "synthesis"],
    supportedTaskTypes: ALL_TASK_TYPES, supportedRoles: ALL_ROLES,
    availability: "available", enabled: true, simulated: true, external: true,
    requiresNetwork: false, requiresCredentials: false,
    riskClass: "low", priority: 70, costClass: "low", latencyClass: "medium", contextClass: "high", outputClass: "medium",
    safeMetadata: { focus: "research-structure" }
  }
]);

// Purely simulated model profiles — only safe internal metadata and coarse
// classes. No real prices, tokens, context windows or performance claims.
export const MODEL_DEFINITIONS = Object.freeze([
  { modelId: "mock-deterministic-v1", providerId: "mock-local", capabilities: ["analysis", "synthesis"], supportedRoles: ALL_ROLES, reasoningClass: "low", speedClass: "high", costClass: "low", contextClass: "medium", deterministicSimulationProfile: "mock-baseline", enabled: true, simulated: true },
  { modelId: "codex-local-readonly", providerId: "codex-local-readonly", capabilities: ["coding", "analysis", "review"], supportedRoles: ["executor", "reviewer"], reasoningClass: "medium", speedClass: "medium", costClass: "low", contextClass: "high", deterministicSimulationProfile: "codex-readonly", enabled: true, simulated: false },
  { modelId: "claude-general-sim", providerId: "claude-simulated", capabilities: ["planning", "analysis", "review", "synthesis"], supportedRoles: ALL_ROLES, reasoningClass: "high", speedClass: "medium", costClass: "medium", contextClass: "high", deterministicSimulationProfile: "claude-general", enabled: true, simulated: true },
  { modelId: "claude-architecture-sim", providerId: "claude-simulated", capabilities: ["architecture", "planning", "review"], supportedRoles: ["planner", "reviewer"], reasoningClass: "high", speedClass: "medium", costClass: "high", contextClass: "high", deterministicSimulationProfile: "claude-architecture", enabled: true, simulated: true },
  { modelId: "openai-general-sim", providerId: "openai-simulated", capabilities: ["analysis", "planning", "synthesis", "writing"], supportedRoles: ALL_ROLES, reasoningClass: "medium", speedClass: "high", costClass: "medium", contextClass: "medium", deterministicSimulationProfile: "openai-general", enabled: true, simulated: true },
  { modelId: "openai-coding-sim", providerId: "openai-simulated", capabilities: ["coding", "debugging", "analysis"], supportedRoles: ["executor", "reviewer"], reasoningClass: "high", speedClass: "medium", costClass: "medium", contextClass: "high", deterministicSimulationProfile: "openai-coding", enabled: true, simulated: true },
  { modelId: "gemini-research-sim", providerId: "gemini-simulated", capabilities: ["research-planning", "analysis", "summarization"], supportedRoles: ALL_ROLES, reasoningClass: "medium", speedClass: "medium", costClass: "low", contextClass: "high", deterministicSimulationProfile: "gemini-research", enabled: true, simulated: true }
]);

function classOrNull(value) { return PROVIDER_CLASS_LEVELS.includes(value) ? value : null; }

// A model profile carries only safe metadata; invalid ones are dropped.
function validateModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!ALLOWED_MODEL_IDS.includes(raw.modelId)) return null;
  if (!ALLOWED_PROVIDER_IDS.includes(raw.providerId)) return null;
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities.filter((c) => ALLOWED_CAPABILITIES.includes(c)) : [];
  const supportedRoles = Array.isArray(raw.supportedRoles) ? raw.supportedRoles.filter((r) => ALLOWED_ROLES.includes(r)) : [];
  if (!capabilities.length || !supportedRoles.length) return null;
  if (![raw.reasoningClass, raw.speedClass, raw.costClass, raw.contextClass].every((c) => classOrNull(c))) return null;
  if (typeof raw.deterministicSimulationProfile !== "string" || !raw.deterministicSimulationProfile) return null;
  if (typeof raw.enabled !== "boolean" || typeof raw.simulated !== "boolean") return null;
  return Object.freeze({
    modelId: raw.modelId, providerId: raw.providerId,
    capabilities: Object.freeze(capabilities), supportedRoles: Object.freeze(supportedRoles),
    reasoningClass: raw.reasoningClass, speedClass: raw.speedClass, costClass: raw.costClass, contextClass: raw.contextClass,
    deterministicSimulationProfile: raw.deterministicSimulationProfile.replace(/[^a-z0-9-]/gi, "").slice(0, 40),
    enabled: raw.enabled, simulated: raw.simulated
  });
}

// Builds the authoritative, self-validating provider registry. Inconsistent
// entries are marked invalid/unavailable instead of crashing the router; the
// mock provider always stays available as the safe simulation fallback. There
// is never a silent fallback from a disallowed provider to a real adapter.
export function createProviderRegistry({ providerDefs = PROVIDER_DEFINITIONS, modelDefs = MODEL_DEFINITIONS } = {}) {
  const providers = new Map();
  const invalid = [];
  const seen = new Set();

  for (const def of providerDefs) {
    const providerId = def && typeof def === "object" ? def.providerId : null;
    if (providerId && seen.has(providerId)) { invalid.push({ providerId, reason: "duplicate" }); continue; }
    if (providerId) seen.add(providerId);
    if (isValidProviderContract(def)) providers.set(def.providerId, createProviderContract(def));
    else invalid.push({ providerId: ALLOWED_PROVIDER_IDS.includes(providerId) ? providerId : null, reason: "invalid" });
  }

  const models = new Map();
  for (const raw of modelDefs) {
    const model = validateModel(raw);
    if (model && !models.has(model.modelId)) models.set(model.modelId, model);
  }

  const registryStatus = invalid.length === 0 ? "ok" : "degraded";

  function providerStatuses() {
    const live = [...providers.values()].map((provider) => ({
      providerId: provider.providerId,
      status: provider.enabled ? provider.availability : "unavailable",
      simulated: provider.simulated,
      executable: provider.executable,
      checkedAt: null
    }));
    const broken = invalid.map((entry) => ({ providerId: entry.providerId, status: "invalid", simulated: true, executable: false, checkedAt: null }));
    return [...live, ...broken].filter((entry) => entry.providerId);
  }

  return {
    registryStatus,
    // Full internal contracts (never sent to clients directly).
    list() { return [...providers.values()]; },
    get(providerId) { return providers.get(providerId) || null; },
    has(providerId) { return providers.has(providerId); },
    isExecutable(providerId) { const p = providers.get(providerId); return Boolean(p && p.executable && p.enabled); },
    isEnabled(providerId) { const p = providers.get(providerId); return Boolean(p && p.enabled); },
    getModel(modelId) { return models.get(modelId) || null; },
    listModels() { return [...models.values()]; },
    modelsForProvider(providerId) { return [...models.values()].filter((m) => m.providerId === providerId); },
    // Safe public projections for the API.
    publicList() { return [...providers.values()].map(projectPublicProvider); },
    publicGet(providerId) { const p = providers.get(providerId); return p ? projectPublicProvider(p) : null; },
    invalidEntries() { return invalid.slice(); },
    // Safe operational summary for health/diagnostics/cockpit.
    status() {
      const live = [...providers.values()];
      return {
        registryStatus,
        providerCount: live.length,
        enabledProviderCount: live.filter((p) => p.enabled).length,
        simulatedProviderCount: live.filter((p) => p.simulated).length,
        executableProviderCount: live.filter((p) => p.executable && p.enabled).length,
        invalidProviderCount: invalid.length,
        providerStatuses: providerStatuses()
      };
    }
  };
}

export const providerRegistry = createProviderRegistry();
