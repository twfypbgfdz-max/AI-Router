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

function classifyTask(text) {
  const rules = [
    ["obsidian", [/\bobsidian\b/, /\bvault\b/, /\bzettelkasten\b/]],
    ["social_media", [/social[ -]?media/, /\binstagram\b/, /\blinkedin\b/, /\btiktok\b/, /\breel\b/, /\bhashtag/]],
    ["finance", [/\bfinanz/, /\bbudget/, /\baktie/, /\bsteuer/, /\bzahlung/, /\bbezahlen\b/, /\bkaufen\b/, /\bvertrag/]],
    ["career", [/\bkarriere/, /\bbewerbung/, /\blebenslauf/, /\bvorstellungsgesprach/, /\bjobs?\b/]],
    ["code", [/\bcode\b/, /\bbug\b/, /\bfehler/, /\brepositor/, /\brepo\b/, /\bgit\b/, /\bcommit/, /\bpush/, /\bdeploy/, /\bdatei/, /\bordner/, /\bjavascript\b/, /\btypescript\b/, /\bnode(?:\.js)?\b/, /\bhtml\b/, /\bcss\b/, /\bapi\b/]],
    ["research", [/\brecherch/, /\bresearch\b/, /\bquellen?\b/, /\bvergleiche?\b/, /\baktuell(?:e|en|er|es)?\b/, /\bnachschlagen/]],
    ["planning", [/\bplan(?:ung|en)?\b/, /\bkonzept/, /\bstrategie/, /\barchitektur/, /\broadmap\b/, /\bzielbild/]],
    ["everyday", [/\balltag/, /\beinkauf/, /\breise/, /\bkalender/, /\btermin/, /\be-?mail/]],
    ["learning", [/\blernen\b/, /\berklar/, /\bkurs\b/, /\bubung/, /\btutorial\b/]],
    ["writing", [/\bschreib/, /\bformulier/, /\btext\b/, /\bartikel\b/, /\buberarbeit/]]
  ];
  return rules.find(([, patterns]) => matches(text, patterns))?.[0] || "unknown";
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
    /e-?mail.{0,20}send/, /kalender.{0,30}(?:ander|aktualisier|eintrag)/,
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
  if (!TASK_TYPE_SET.has(plan.taskType) || !LEVELS.has(plan.complexity) || !LEVELS.has(plan.importance) || !RISKS.has(plan.risk) || !LEVELS.has(plan.uncertainty) || !LEVELS.has(plan.estimatedUsage)) throw new Error("Invalid route plan.");
  return plan;
}
