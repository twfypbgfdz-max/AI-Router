import crypto from "node:crypto";
import { RECOMMENDATION_MAX_ALTERNATIVES, RECOMMENDATION_SCHEMA_VERSION } from "./config.js";
import { normalizeRecommendationInput } from "./recommendation-contract.js";

const SECURITY_ALERT_CODES = new Set(["SECURITY_BLOCKER", "READ_ONLY_VIOLATION_DETECTED", "SECRET_EXPOSURE", "POLICY_VIOLATION"]);
const RULES = Object.freeze([
  { code: "TESTS_FAILED", workflowId: "assess-test-status", title: "Fehlgeschlagenen Teststatus bewerten", summary: "Die belegten Testmetadaten melden einen Fehlschlag.", field: "quality.tests", matches: (input) => availableState(input.quality.tests, "failed") },
  { code: "QUALITY_EVIDENCE_STALE", workflowId: "check-project-status", title: "Veraltete Quality-Evidence prüfen", summary: "Der belegte Quality-Status ist veraltet oder blockiert.", field: "quality.status", matches: (input) => availableState(input.quality.status, "stale", "blocked") },
  { code: "RELEASE_NOT_READY", workflowId: "assess-release-readiness", title: "Release-Bereitschaft prüfen", summary: "Die belegte Release-Bereitschaft ist blockiert oder verlangt eine Prüfung.", field: "quality.releaseReadiness", matches: (input) => availableState(input.quality.releaseReadiness, "blocked", "not-ready", "review-required") },
  { code: "DOCUMENTATION_NEEDS_REVIEW", workflowId: "check-documentation-gaps", title: "Dokumentationsnachweis prüfen", summary: "Die belegten Dokumentationsdaten sind veraltet oder unvollständig.", field: "quality.documentation", matches: (input) => availableState(input.quality.documentation, "stale", "incomplete", "conflict") },
  { code: "AI_JOB_EVIDENCE_STALE", workflowId: "check-project-status", title: "Veraltete AI-Job-Evidence prüfen", summary: "Mindestens ein laufender oder geplanter AI-Job hat belegbar veraltete Statusdaten.", field: "aiJobs", matches: (input) => input.aiJobs.some((job) => ["planned", "running"].includes(job.status) && job.freshness === "stale" && job.evidence.status === "available") },
  { code: "PREPARE_FOLLOW_UP", workflowId: "prepare-codex-prompt", title: "Nächsten Folgeauftrag vorbereiten", summary: "Ein belegter Hinweis erlaubt die Vorbereitung eines Folgeauftrags; eine Ausführung bleibt ausgeschlossen.", field: "alerts", matches: (input) => input.alerts.some((alert) => alert.code === "PREPARE_FOLLOW_UP" && alert.evidence.status === "available") }
]);

function availableState(item, ...states) {
  return item.evidence.status === "available" && states.includes(item.status);
}

function evidenceFor(input, field) {
  if (field === "aiJobs") {
    const job = input.aiJobs.find((item) => ["planned", "running"].includes(item.status) && item.freshness === "stale" && item.evidence.status === "available");
    return job ? [{ field: `aiJobs.${job.id}.freshness`, status: job.freshness, evidenceStatus: job.evidence.status, evidenceTimestamp: job.evidence.timestamp }] : [];
  }
  if (field === "alerts") {
    const alert = input.alerts.find((item) => item.code === "PREPARE_FOLLOW_UP" && item.evidence.status === "available");
    return alert ? [{ field: `alerts.${alert.code}`, status: alert.severity, evidenceStatus: alert.evidence.status, evidenceTimestamp: alert.evidence.timestamp }] : [];
  }
  const item = field.split(".").reduce((value, key) => value?.[key], input);
  return [{ field, status: item.status, evidenceStatus: item.evidence.status, evidenceTimestamp: item.evidence.timestamp }];
}

function missingEvidence(input) {
  const fields = ["quality.tests", "quality.build", "quality.releaseReadiness", "quality.documentation", "quality.deployment"];
  const missing = [];
  for (const field of fields) {
    const item = field.split(".").reduce((value, key) => value?.[key], input);
    if (item.status === "unknown" || item.status === "unavailable" || item.evidence.status !== "available") missing.push(field);
  }
  if (input.evidence.status !== "available") missing.push("evidence");
  return missing;
}

function allowedWorkflow(input, workflowId) {
  return input.workflows.find((workflow) => workflow.id === workflowId && ["read-only", "prepare-only"].includes(workflow.safetyLevel)) || null;
}

function recommendationId(projectId, ruleCode, workflowId) {
  const digest = crypto.createHash("sha256").update(`${RECOMMENDATION_SCHEMA_VERSION}|${projectId}|${ruleCode}|${workflowId || "none"}`).digest("hex").slice(0, 16);
  return `rec_${digest}`;
}

function buildRecommendation(input, rule, workflow, generatedAt) {
  const evidence = evidenceFor(input, rule.field);
  return Object.freeze({
    recommendationId: recommendationId(input.project.id, rule.code, workflow.id),
    projectId: input.project.id,
    workflowId: workflow.id,
    title: rule.title,
    summary: rule.summary,
    reasonCodes: Object.freeze([rule.code, "EVIDENCE_VERIFIED", "WORKFLOW_DASHBOARD_ALLOWLISTED", "HIGHER_RISK_WORKFLOWS_EXCLUDED"]),
    evidence: Object.freeze(evidence.map(Object.freeze)),
    confidence: "high",
    safetyLevel: workflow.safetyLevel,
    mode: "observe",
    blockedReasons: Object.freeze(["EXECUTION_DISABLED", "WRITE_AND_EXECUTE_WORKFLOWS_EXCLUDED"]),
    missingEvidence: Object.freeze(missingEvidence(input)),
    generatedAt
  });
}

function noRecommendation(input, generatedAt, blockedReasons) {
  return Object.freeze({
    schemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    mode: "observe",
    generatedAt,
    recommendation: null,
    alternatives: Object.freeze([]),
    blockedReasons: Object.freeze(blockedReasons),
    missingEvidence: Object.freeze(missingEvidence(input)),
    execution: Object.freeze({ allowed: false, performed: false })
  });
}

export function createRecommendations(rawInput, { now = () => new Date() } = {}) {
  const input = normalizeRecommendationInput(rawInput, { now });
  const generatedAt = now().toISOString();
  const securityBlocker = input.alerts.some((alert) => alert.severity === "critical" && alert.evidence.status === "available" && SECURITY_ALERT_CODES.has(alert.code));
  if (securityBlocker) return noRecommendation(input, generatedAt, ["SECURITY_BLOCKER", "NO_WORKFLOW_RECOMMENDED"]);

  const candidates = [];
  for (const rule of RULES) {
    if (!rule.matches(input)) continue;
    const workflow = allowedWorkflow(input, rule.workflowId);
    if (workflow) candidates.push(buildRecommendation(input, rule, workflow, generatedAt));
  }
  if (!candidates.length) {
    const hasMatchedRule = RULES.some((rule) => rule.matches(input));
    return noRecommendation(input, generatedAt, [hasMatchedRule ? "NO_ALLOWLISTED_WORKFLOW" : "NO_EVIDENCE_BASED_ACTION_REQUIRED"]);
  }
  return Object.freeze({
    schemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    mode: "observe",
    generatedAt,
    recommendation: candidates[0],
    alternatives: Object.freeze(candidates.slice(1, 1 + RECOMMENDATION_MAX_ALTERNATIVES)),
    blockedReasons: Object.freeze([]),
    missingEvidence: Object.freeze(missingEvidence(input)),
    execution: Object.freeze({ allowed: false, performed: false })
  });
}
