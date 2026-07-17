import { ALLOWED_PROVIDER_WORKFLOW_PROFILES } from "./policy.js";

function bound(value, maximum = 300) {
  return String(value || "").replace(/[ -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

// Merges several simulated provider role results into one safe synthesis. It
// keeps NO full intermediate results and NO raw provider output — only bounded,
// derived statements. Conflicts between simulated roles are surfaced honestly
// and, when present without a review, uncertainty is raised and a review
// recommended. It never triggers any real external action.
export function synthesizeProviderResults({ workflowProfile = "single_provider", roleResults = [], uncertainty = "low" } = {}) {
  const profile = ALLOWED_PROVIDER_WORKFLOW_PROFILES.includes(workflowProfile) ? workflowProfile : "single_provider";
  const results = Array.isArray(roleResults) ? roleResults.filter((r) => r && typeof r === "object") : [];
  const completed = results.filter((r) => r.status === "succeeded");
  const rolesCompleted = completed.map((r) => r.role).filter(Boolean);
  const providersUsed = [...new Set(results.map((r) => r.providerId).filter(Boolean))];
  const distinctProviders = providersUsed.length;
  const reviewer = results.find((r) => r.role === "reviewer");

  const agreements = [];
  agreements.push("Alle Rollen bestätigen: ausschließlich lokale Simulation, keine externe KI und keine reale Aktion.");
  if (distinctProviders > 1) agreements.push("Die simulierten Profile stimmen im sicheren, read-only Rahmen überein.");

  const disagreements = [];
  const failedOrSkipped = results.filter((r) => r.status && r.status !== "succeeded");
  if (distinctProviders > 1) disagreements.push(bound(`Unterschiedliche Profilschwerpunkte (${providersUsed.join(", ")}); das Ergebnis ist eine lokale Zusammenführung, keine externe Einigung.`));
  for (const item of failedOrSkipped) disagreements.push(bound(`Rolle ${item.role} wurde nicht erfolgreich abgeschlossen (${item.status}).`));

  // Conclusion = the final synthesizer summary if present, else the last success.
  const synthStep = [...completed].reverse().find((r) => r.role === "synthesizer");
  const conclusionStep = synthStep || completed[completed.length - 1] || null;
  const selectedConclusion = bound(conclusionStep?.summary || "Keine belastbare Zusammenführung verfügbar.", 400);

  let effectiveUncertainty = uncertainty;
  const warnings = [];
  let reviewStatus;
  if (reviewer && reviewer.status === "succeeded") reviewStatus = "reviewed";
  else if (disagreements.length) { reviewStatus = "review_recommended"; if (effectiveUncertainty !== "high") effectiveUncertainty = "high"; warnings.push("Widersprüche zwischen simulierten Rollen erkannt; eine Prüfung wird empfohlen."); }
  else reviewStatus = "not_reviewed";

  return {
    workflowProfile: profile,
    providersUsed,
    rolesCompleted,
    agreements: agreements.slice(0, 6).map((v) => bound(v)),
    disagreements: disagreements.slice(0, 6),
    selectedConclusion,
    safeSummary: bound(`Lokale Multi-Provider-Simulation (${profile}) mit ${distinctProviders} Profil(en) sicher zusammengeführt. Keine reale externe Aktion.`, 300),
    warnings: warnings.slice(0, 6).map((v) => bound(v)),
    simulated: true,
    reviewStatus,
    uncertainty: effectiveUncertainty
  };
}
