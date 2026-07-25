import { selectWorkflowType } from "./workflow-engine.js";
import { classifyTask } from "./task-classifier.js";

export const ROUTER_ROUTES = Object.freeze([
  "general_chat", "task_management", "project_management", "knowledge_query",
  "content_generation", "system_status", "cockpit_command", "unsupported", "blocked"
]);

export const TASK_TYPES = Object.freeze(["code", "research", "planning", "writing", "obsidian", "social_media", "learning", "career", "finance", "everyday", "unknown"]);
const TASK_TYPE_SET = new Set(TASK_TYPES);
const LEVELS = new Set(["low", "medium", "high"]);
const RISKS = new Set(["R0", "R1", "R2", "R3", "R4"]);

function normalized(value) {
  return String(value || "")
    .toLocaleLowerCase("de-DE")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss");
}

function matches(text, patterns) { return patterns.some((pattern) => pattern.test(text)); }

const BLOCKED_PATTERNS = [
  /\b(?:l(?:o|oe)sch\w*|entfern\w*|delete\w*|remove\w*)\b.{0,40}\b(?:datei\w*|ordner\w*|files?|folders?|director(?:y|ies))\b/,
  /\b(?:datei\w*|ordner\w*|files?|folders?|director(?:y|ies))\b.{0,40}\b(?:l(?:o|oe)sch\w*|entfern\w*|delete\w*|remove\w*)\b/,
  /\b(?:(?:u|ue)berschreib\w*|overwrite\w*)\b.{0,40}\b(?:datei\w*|files?)\b/,
  /\b(?:datei\w*|files?)\b.{0,40}\b(?:(?:u|ue)berschreib\w*|overwrite\w*)\b/,
  /\b(?:send\w*|verschick\w*)\b.{0,32}\b(?:e-?mail|email|nachricht)\b/,
  /\b(?:e-?mail|email|nachricht)\b.{0,32}\b(?:send\w*|verschick\w*)\b/,
  /\b(?:ander\w*|change\w*|edit\w*|delete\w*)\b.{0,32}\b(?:kalender|calendar)\b/,
  /\b(?:kalender|calendar)\b.{0,32}\b(?:ander\w*|change\w*|edit\w*|delete\w*)\b/,
  /\b(?:fuhr\w*|start\w*|run\w*|execut\w*)\b.{0,48}\b(?:shell|powershell|terminal|cmd)(?:[- ]?(?:befehl|command))?\b/,
  /\b(?:shell|powershell|terminal|cmd)(?:[- ]?(?:befehl|command))?\b.{0,48}\b(?:fuhr\w*|start\w*|run\w*|execut\w*)\b/,
  /\b(?:gib\w*|zeig\w*|ausgib\w*|offenleg\w*|show\w*|reveal\w*|print\w*)\b.{0,40}\b(?:secret|token|passwort|password|credential\w*|zugangsdaten)\b/,
  /\b(?:secret|token|passwort|password|credential\w*|zugangsdaten)\b.{0,40}\b(?:gib\w*|zeig\w*|ausgib\w*|offenleg\w*|show\w*|reveal\w*|print\w*)\b/,
  /\b(?:push\w*|commit\w*|merge\w*|reset\w*)\b.{0,40}\b(?:git|github|repository|repo)\b/,
  /\b(?:git|github|repository|repo)(?:[- ]?commit)?\b.{0,40}\b(?:push\w*|commit\w*|merge\w*|reset\w*|erstell\w*|creat\w*)\b/,
  /\b(?:erstell\w*|creat\w*)\b.{0,40}\bgit[- ]?commit\b/,
  /(?:benutzer|user).{0,24}(?:anleg|l(?:o|oe)sch|rechte)/,
  /(?:pc|computer).{0,24}(?:steuer|herunterfahr|neustart)/
];

const ROUTE_RULES = Object.freeze([
  { name: "system_status", patterns: [/\bstatus\b/, /gesundheit/, /health\b/, /erreichbar/, /router.{0,16}(?:version|status)/], confidence: 0.96, reason: "Die Anfrage betrifft den Betriebsstatus des Routers.", capabilities: ["read_system_status"], action: "router.status", riskLevel: "low" },
  { name: "cockpit_command", patterns: [/\bcockpit\b/, /tagessteuerung/, /dashboard/], confidence: 0.9, reason: "Die Anfrage bezieht sich auf eine sichere Cockpit-Vorschau.", capabilities: ["preview_cockpit"], action: "cockpit.preview", riskLevel: "low" },
  { name: "task_management", patterns: [/\baufgab/, /\btasks?\b/, /\bto-?do/, /heutig.{0,16}(?:punkt|arbeit)/, /priorisier/], confidence: 0.92, reason: "Die Anfrage bezieht sich auf Aufgaben oder Prioritaeten.", capabilities: ["read_tasks"], action: "tasks.list", riskLevel: "low" },
  { name: "project_management", patterns: [/\bprojekt/, /\broadmap\b/, /meilenstein/, /projektstand/], confidence: 0.9, reason: "Die Anfrage bezieht sich auf Projekte oder Projektstaende.", capabilities: ["read_projects"], action: "projects.status", riskLevel: "low" },
  { name: "content_generation", patterns: [/\bschreib/, /\bformulier/, /\berstell.{0,16}(?:text|entwurf|inhalt|post)/, /\bentwurf\b/, /zusammenfass/], confidence: 0.88, reason: "Die Anfrage verlangt einen Inhalt oder eine Zusammenfassung.", capabilities: ["generate_content"], action: "router.explain", riskLevel: "low" },
  { name: "knowledge_query", patterns: [/\bwas\b/, /\bwie\b/, /\bwarum\b/, /\berkl(?:a|ae)r/, /\bwissen/, /\binformation/, /\bfrage\b/], confidence: 0.84, reason: "Die Anfrage ist eine Wissens- oder Erklaerfrage.", capabilities: ["answer_from_available_context"], action: "router.explain", riskLevel: "low" },
  { name: "general_chat", patterns: [/\bhallo\b/, /\bhi\b/, /\bguten\s+(?:morgen|tag|abend)/, /\bhilfe\b/, /\bunterstutz/, /\bmeinung\b/, /\bideen?\b/], confidence: 0.78, reason: "Die Anfrage ist eine allgemeine, nicht-operative Unterhaltung.", capabilities: ["general_response"], action: "router.explain", riskLevel: "low" }
]);

export function createRouterDecision(content) {
  const text = normalized(content);
  if (matches(text, BLOCKED_PATTERNS)) {
    return Object.freeze({ route: "blocked", confidence: 0.99, reason: "Die Anfrage beschreibt eine aktuell nicht freigegebene oder riskante Aktion.", requiredCapabilities: [], proposedAction: null, riskLevel: "critical", simulated: true });
  }
  const rule = ROUTE_RULES.find(({ patterns }) => matches(text, patterns));
  if (!rule) return Object.freeze({ route: "unsupported", confidence: 0.35, reason: "Die Anfrage laesst sich keiner freigeschalteten Route sicher zuordnen.", requiredCapabilities: [], proposedAction: null, riskLevel: "unknown", simulated: true });
  return Object.freeze({ route: rule.name, confidence: rule.confidence, reason: rule.reason, requiredCapabilities: [...rule.capabilities], proposedAction: rule.action, riskLevel: rule.riskLevel, simulated: true });
}

function safeSummary(value, maximum = 300) {
  return String(value || "")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]")
    .replace(/\b(api[_ -]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function assessRisk(text, taskType) {
  const riskText = text.replace(/\b(?:nicht|kein|keine|keinen|keiner|ohne)\b.{0,24}\b(?:losch\w*|entfern\w*|commit\w*|push\w*|deploy\w*|veroffentlich\w*|send\w*|ander\w*|verander\w*|schreib\w*|kauf\w*|bezahl\w*|ausfuhr\w*)\b/g, "");
  const r4 = [
    /(?:datei|dateien|ordner).{0,30}(?:losch|entfern)/,
    /(?:losch|entfern).{0,30}(?:datei|dateien|ordner)/,
    /produktion.{0,30}deploy|deploy.{0,30}produktion/,
    /produktiv(?:e|en|er|es)?.{0,40}(?:branch)?.{0,20}push/,
    /(?:secret|secrets).{0,30}(?:ander|verander)/,
    /zahlung.{0,30}ausfuhr/,
    /zugangsdaten.{0,30}weiterg/
  ];
  if (matches(riskText, r4)) return "R4";
  const r3 = [
    /\blosch/, /\bentfern/, /\bcommit/, /\bpush/, /\bdeploy/, /\bveroffentlich/,
    /e-?mail.{0,20}send/, /send.{0,20}e-?mail/, /kalender.{0,30}(?:ander|aktualisier|eintrag)/,
    /\bkaufen\b/, /\bbezahlen\b/, /\bvertrag/, /finanzdaten.{0,30}(?:ander|verander)/,
    /rechte.{0,30}(?:ander|verander)/, /(?:secret|secrets).{0,30}(?:ander|verander)/
  ];
  if (matches(riskText, r3)) return "R3";
  if (taskType === "finance") return "R2";
  if (matches(riskText, [/\b(?:ander|verander|bearbeit|schreib|aktualisier|erstell)/])) return "R1";
  return "R0";
}

function assessComplexity(text, taskType, risk) {
  if (risk === "R4" || matches(text, [/\bvollstandig/, /\bmehrere\b/, /\bmigration/, /\brefactor/, /\barchitektur/, /\bsystematisch/]) || text.length > 400) return "high";
  if (["code", "research", "planning", "finance"].includes(taskType) || text.length > 120) return "medium";
  return "low";
}

function assessImportance(text, taskType, risk) {
  if (["R3", "R4"].includes(risk) || matches(text, [/\bdringend/, /\bwichtig/, /\bproduktion/, /\bvertrag/, /\bfinal(?:e|en|er|es)?\b/])) return "high";
  if (["code", "finance", "career"].includes(taskType) || matches(text, [/\bpruf/, /\bentscheidung/])) return "medium";
  return "low";
}

function recommendedRoute(taskType) {
  if (taskType === "code") return "codex-cli";
  if (taskType === "planning") return "claude";
  if (["research", "writing", "obsidian", "social_media", "learning", "career", "finance", "everyday"].includes(taskType)) return "chatgpt";
  return "mock";
}

const REASONS = Object.freeze({
  code: "Die Aufgabe betrifft Code oder ein technisches Repository.",
  research: "Die Aufgabe verlangt Recherche oder einen Quellenvergleich.",
  planning: "Die Aufgabe betrifft Planung, Konzept oder Architektur.",
  writing: "Die Aufgabe betrifft das Formulieren oder Überarbeiten von Text.",
  obsidian: "Die Aufgabe betrifft Obsidian oder eine strukturierte Wissensablage.",
  social_media: "Die Aufgabe betrifft Inhalte für soziale Medien.",
  learning: "Die Aufgabe betrifft Lernen, Erklären oder Üben.",
  career: "Die Aufgabe betrifft Karriere oder Bewerbung.",
  finance: "Die Aufgabe betrifft Finanzen und erfordert erhöhte Sorgfalt.",
  everyday: "Die Aufgabe betrifft eine alltägliche Organisation oder Entscheidung.",
  unknown: "Die Aufgabe lässt sich keiner freigegebenen Aufgabenart eindeutig zuordnen."
});

export function createRoutePlan(task) {
  const text = normalized(task);
  const taskType = classifyTask(text);
  const risk = assessRisk(text, taskType);
  const complexity = assessComplexity(text, taskType, risk);
  const importance = assessImportance(text, taskType, risk);
  const uncertainty = taskType === "unknown" || (taskType === "research" && matches(text, [/\baktuell/, /\bheute\b/, /\bneueste/])) ? "high" : (["code", "planning", "research", "finance"].includes(taskType) ? "medium" : "low");
  const estimatedUsage = complexity;
  const approvalRequired = risk === "R3" || risk === "R4";
  const reviewRequired = approvalRequired || risk === "R2" || complexity === "high" || importance === "high" || uncertainty === "high";
  const route = recommendedRoute(taskType);
  const warnings = [];
  if (route !== "mock") warnings.push("Die empfohlene Route ist nur Metadatum; sie wird nicht automatisch gestartet.");
  if (taskType === "research") warnings.push("Die Routing-Engine führt keine externe Recherche aus.");
  if (approvalRequired) warnings.push("Freigabe erforderlich: Die erkannte Aktion wird nicht ausgeführt; nur der Route-Plan darf simuliert werden.");

  const plan = { taskType, recommendedRoute: route, executionAdapter: "mock", reason: REASONS[taskType], complexity, importance, risk, uncertainty, estimatedUsage, reviewRequired, approvalRequired, warnings };
  plan.workflowType = selectWorkflowType(plan);
  if (!TASK_TYPE_SET.has(plan.taskType) || !LEVELS.has(plan.complexity) || !LEVELS.has(plan.importance) || !RISKS.has(plan.risk) || !LEVELS.has(plan.uncertainty) || !LEVELS.has(plan.estimatedUsage)) throw new Error("Invalid route plan.");
  return plan;
}

export function createApprovalContext(task, routePlan) {
  if (!routePlan?.approvalRequired) return null;
  const text = normalized(task);
  const affectedSystems = [];
  const affectedResources = [];
  const possibleConsequences = [];
  const add = (list, value) => { if (!list.includes(value)) list.push(value); };

  if (matches(text, [/\bdatei/, /\bordner/, /\blosch/, /\bentfern/])) {
    add(affectedSystems, "Lokales Dateisystem");
    add(affectedResources, "In der Aufgabe genannte Dateien oder Ordner");
    add(possibleConsequences, "Daten können dauerhaft verloren gehen.");
  }
  if (matches(text, [/\bgit\b/, /\bcommit/, /\bpush/, /\bbranch/])) {
    add(affectedSystems, "Git-Repository");
    add(affectedResources, "Repository, Branch und Commit-Historie");
    add(possibleConsequences, "Repository-Zustand oder veröffentlichte Historie können verändert werden.");
  }
  if (matches(text, [/\bdeploy/, /\bproduktion/, /\bveroffentlich/])) {
    add(affectedSystems, "Produktions- oder Veröffentlichungssystem");
    add(affectedResources, "Produktive Umgebung oder öffentlich sichtbare Inhalte");
    add(possibleConsequences, "Änderungen können unmittelbar produktiv oder öffentlich wirksam werden.");
  }
  if (matches(text, [/\be-?mail/, /\bsend/])) {
    add(affectedSystems, "E-Mail-System");
    add(affectedResources, "E-Mail-Konto und Empfänger");
    add(possibleConsequences, "Eine versendete Nachricht kann nicht zuverlässig zurückgerufen werden.");
  }
  if (matches(text, [/\bkalender/, /\btermin/])) {
    add(affectedSystems, "Kalendersystem");
    add(affectedResources, "Kalenderkonto, Termine und mögliche Teilnehmer");
    add(possibleConsequences, "Termine oder Einladungen können für weitere Personen verändert werden.");
  }
  if (matches(text, [/\bzahlung/, /\bbezahlen/, /\bkaufen/, /\bfinanz/, /\bvertrag/])) {
    add(affectedSystems, "Finanz-, Einkaufs- oder Vertragssystem");
    add(affectedResources, "Zahlungskonto, Budget oder Vertragsdaten");
    add(possibleConsequences, "Es können finanzielle oder rechtliche Verpflichtungen entstehen.");
  }
  if (matches(text, [/\bsecret/, /\bzugangsdaten/, /\brechte/])) {
    add(affectedSystems, "Zugriffs- und Berechtigungssystem");
    add(affectedResources, "Konten, Secrets, Zugangsdaten oder Rechte");
    add(possibleConsequences, "Zugriffsschutz oder Kontosicherheit können beeinträchtigt werden.");
  }
  if (!affectedSystems.length) add(affectedSystems, "Nicht eindeutig ableitbar");
  if (!affectedResources.length) add(affectedResources, "Keine konkreten Dateien oder Konten sicher ableitbar");
  if (!possibleConsequences.length) add(possibleConsequences, "Die Aufgabe kann einen extern sichtbaren oder schwer rückgängig zu machenden Zustand verändern.");

  const irreversible = routePlan.risk === "R4" || matches(text, [/\blosch/, /\bzahlung/, /\bbezahlen/, /\bveroffentlich/, /\be-?mail.{0,20}send/]);
  return {
    plannedAction: safeSummary(task),
    whyApprovalRequired: routePlan.risk === "R4" ? "Produktive oder destruktive Aktion mit hohem Schadenspotenzial." : "Riskante Aktion mit externer oder dauerhafter Wirkung.",
    possibleConsequences,
    affectedSystems,
    affectedResources,
    reversibility: irreversible ? "irreversible_or_limited" : "limited_or_unknown",
    recommendedRoute: routePlan.recommendedRoute,
    executionAdapter: "mock",
    warnings: [...routePlan.warnings]
  };
}
