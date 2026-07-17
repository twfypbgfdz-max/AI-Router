import { providerRegistry } from "./provider-registry.js";

// Deterministic, per-provider-profile role summaries. These are LOCAL
// SIMULATIONS. They never claim that a real Claude, OpenAI, Gemini or Codex
// model answered — the wording is always "Lokale <Profil>-Simulation".
const PROVIDER_LABELS = Object.freeze({
  "mock-local": "Mock",
  "codex-local-readonly": "Codex read-only (lokal)",
  "claude-simulated": "Lokale Claude-Profil-Simulation",
  "openai-simulated": "Lokale OpenAI-Profil-Simulation",
  "gemini-simulated": "Lokale Gemini-Profil-Simulation"
});

const ROLE_FOCUS = Object.freeze({
  "claude-simulated": {
    planner: "Schwerpunkt Planung und Architektur: Ziel, sichere Schritte und Abwägungen strukturiert bestimmt.",
    executor: "Schwerpunkt strukturierte Umsetzung mit Architekturblick, rein simuliert.",
    reviewer: "Schwerpunkt Prüfung: Konsistenz, Risiken und Abwägungen begrenzt bewertet.",
    synthesizer: "Ergebnisse abwägend und begründet zusammengeführt."
  },
  "openai-simulated": {
    planner: "Schwerpunkt klare, strukturierte allgemeine Planung, rein simuliert.",
    executor: "Schwerpunkt strukturierte allgemeine Lösung und Umsetzung, rein simuliert.",
    reviewer: "Schwerpunkt pragmatische Prüfung von Umsetzung und Vollständigkeit.",
    synthesizer: "Ergebnisse zu einer klaren Gesamtlösung zusammengeführt."
  },
  "gemini-simulated": {
    planner: "Schwerpunkt Rechercheplan und Informationsstruktur, rein simuliert.",
    executor: "Schwerpunkt Vergleich und strukturierte Informationsaufbereitung, rein simuliert.",
    reviewer: "Schwerpunkt Prüfung von Quellenlogik und Vollständigkeit der Struktur.",
    synthesizer: "Vergleich und Informationsstruktur zusammengeführt."
  },
  "codex-local-readonly": {
    executor: "Schwerpunkt read-only Code-Analyse (in dieser Kette simuliert, kein realer Modelllauf).",
    reviewer: "Schwerpunkt read-only Code-Prüfung (in dieser Kette simuliert)."
  }
});

function focusText(providerId, role) {
  const table = ROLE_FOCUS[providerId];
  return (table && table[role]) || "Rolle im Simulationsmodus verarbeitet; keine externe KI und keine reale Aktion.";
}

// The deterministic safe summary for one simulated provider role. Bounded and
// carries no prompts, user text or raw provider output.
export function providerRoleSummary(providerId, role) {
  const label = PROVIDER_LABELS[providerId] || "Lokale Simulation";
  return `[${label} · ${role}] ${focusText(providerId, role)}`.slice(0, 500);
}

// Reflavors an already-produced (deterministic) mock role result with the
// provider profile. Never changes success/failure/timeout/retry behaviour — it
// only relabels a SUCCESSFUL summary and attaches safe provider metadata. The
// baseline mock provider is passed through unchanged.
export function flavorRoleResult(base, { providerId = "mock-local", modelId = null, role = "executor", simulationProfile = null } = {}) {
  if (!base || typeof base !== "object") return base;
  // Every role that flows through this mock-based path is a local simulation.
  const meta = { providerId, modelId, role, simulationProfile, simulated: true };
  // Only reflavor a clean success; failures/timeouts keep their controlled result.
  const isSuccess = base.exitCode === 0 && !(Array.isArray(base.issues) && base.issues.length) && base.resultSummary;
  if (!isSuccess || providerId === "mock-local") return { ...base, ...meta };
  return { ...base, ...meta, resultSummary: providerRoleSummary(providerId, role) };
}

// Convenience for tests / previews: which model a provider would use for a role.
export function modelForProviderRole(providerId, role, registry = providerRegistry) {
  const provider = registry.get(providerId);
  if (!provider) return null;
  const roleModel = registry.modelsForProvider(providerId).find((m) => m.supportedRoles.includes(role));
  return (roleModel && roleModel.modelId) || provider.modelId;
}
