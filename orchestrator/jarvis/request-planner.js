// J1.1 - Freitextauftrag -> strukturierter Auftrag. The smallest vertical
// slice asked for in the 2026-08-29 handoff: turn a natural-language Jarvis
// utterance into a structured, machine-readable plan that a later step can
// feed into the EXISTING run/action infrastructure. This module starts no
// process, calls no adapter, and writes nothing - it only classifies and
// resolves, reusing already-audited building blocks wherever one exists:
//   - classifyIntent()   (intent/intent-router.js, R2)  - conversational intent
//   - createRoutePlan()  (routing-engine.js)            - task type + risk/approval
//   - resolveProject()   (./project-registry.js, J1.1)  - closed project allowlist
// The only genuinely new decision logic here is the analysis-vs-implementation
// verb split needed to tell "Prüf den AI-Router" apart from "Beheb den Fehler
// im AI-Router" - R2's five intents both call "knowledge" (see intent-rules.js
// R2 spec's own boundary example), and that split does not exist anywhere
// else in this codebase yet.
import { classifyIntent } from "../intent/intent-router.js";
import { createRoutePlan } from "../routing-engine.js";
import { RouterError } from "../contracts.js";
import { MAX_TASK_LENGTH } from "../config.js";
import { knownMentions, resolveProject } from "./project-registry.js";

export const TASK_CLASSES = Object.freeze([
  "knowledge_question", "status_query", "operational_query", "conversation_followup",
  "local_action", "code_analysis", "code_implementation"
]);

export const PLANNER_MODES = Object.freeze(["read_only", "write"]);

// Continuing previous work ("mach weiter", "weitermachen") is treated as an
// implementation signal, not a status question - matches the handoff's own
// worked example ("Jarvis, mach beim AI-Router mit dem nächsten Block
// weiter." must resolve to a code/Umsetzungsauftrag).
const IMPLEMENTATION_VERB_PATTERN = /\b(beheb(?:e|en)?|behoben|fix(?:e|en)?|implementier(?:e|en)?|bau(?:e|en)?|ergänz(?:e|en)?|hinzufüg(?:e|en)?|korrigier(?:e|en)?|refactor(?:e|en)?|umsetz(?:e|en)?|weitermach(?:en)?|lös(?:e|en)?\s+das\s+problem)\b/i;
// German separable verbs ("weitermachen") routinely split across a clause
// ("Mach beim AI-Router mit dem nächsten Block weiter.") - a single
// contiguous regex would miss that, so this checks "mach..." appears
// anywhere and "weiter" lands in the trailing few words instead.
function looksLikeContinueWork(text) {
  if (!/\bmach\w*\b/i.test(text)) return false;
  const words = text.trim().split(/\s+/).slice(-3).join(" ");
  return /\bweiter\b/i.test(words);
}
const ANALYSIS_VERB_PATTERN = /\b(prüf(?:e|en)?|analysier(?:e|en)?|check(?:e|en)?|review(?:e|en)?|begutachte(?:n)?|schau\w*\s+dir\s+an|sieh\w*\s+dir\s+an|wie\s+ist\s+der\s+stand|was\s+ist\s+der\s+stand|aktuelle\w*\s+stand)\b/i;

// Bounded, deliberately narrow: German capitalizes every noun, so
// "beim Cockpit" cannot be told apart from an ordinary sentence by
// capitalization alone (unlike English). Only an explicit project-noun
// marker ("Projekt X", "Repo X") is treated as a signal that a project WAS
// named but is not in the registry - anything else with no known alias
// falls back to "none" (no project stated) rather than a guessed "unknown",
// which is the safer failure mode. Open point for J1.2: a real segmentation
// step if this proves too narrow in practice.
const EXPLICIT_UNKNOWN_PROJECT_MARKER = /\b(?:projekt|repo|repository)\s+([\p{L}][\p{L}\p{N}_-]{1,40})/iu;

function normalizeForScan(value) {
  return String(value || "")
    .toLocaleLowerCase("de-DE")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss");
}

// Scans free text for the longest known project alias/id/name and resolves
// it, or falls through to the explicit-unknown-marker check, or "none".
// Kept separate from project-registry.js's resolveProject() (a pure lookup
// on an already-extracted mention) so the registry stays a simple table and
// this scan - the part that can eventually be swapped for something less
// naive - lives in one place.
function extractProjectMention(question) {
  const text = normalizeForScan(question);
  for (const mention of knownMentions()) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u");
    if (pattern.test(text)) return resolveProject(mention);
  }
  const explicitMatch = question.match(EXPLICIT_UNKNOWN_PROJECT_MARKER);
  if (explicitMatch) return Object.freeze({ status: "unknown", mention: explicitMatch[1] });
  return Object.freeze({ status: "none" });
}

function classifyTaskClass({ intent, project, question }) {
  if (intent.intent === "action") return "local_action";
  if (intent.intent === "system") return "status_query";
  if (intent.intent === "operational") return "operational_query";
  if (intent.intent === "conversation") return "conversation_followup";
  // intent.intent === "knowledge" (R2's historical default bucket) - only
  // here is the analysis/implementation split even relevant, and only when
  // a real project is on the table; a pure "Was ist Felix Core?" question
  // with no resolved project stays a knowledge question exactly as before.
  if (project.status === "resolved") {
    if (IMPLEMENTATION_VERB_PATTERN.test(question) || looksLikeContinueWork(question)) return "code_implementation";
    if (ANALYSIS_VERB_PATTERN.test(question)) return "code_analysis";
  }
  return "knowledge_question";
}

function agentForTaskClass(taskClass) {
  switch (taskClass) {
    case "local_action": return Object.freeze({ id: "jarvis-action-layer", available: true, note: "Bestehende R4/R6 Action-Pipeline (action-service.js)." });
    case "code_analysis": return Object.freeze({ id: "codex-cli", available: true, note: "Bestehender realer read-only Adapter (codex-local-readonly)." });
    case "code_implementation":
      // No real write executor exists anywhere in this codebase today - see
      // policy.js: ALLOWED_ADAPTERS/EXECUTABLE_PROVIDER_IDS have no
      // "claude-code" entry, and ALLOWED_REQUESTED_MODES has no "write".
      // Recognized but never executed, same pattern as R2's own action
      // matcher (matchActionIntent -> executionAvailable: false).
      return Object.freeze({ id: "claude-code", available: false, note: "Claude-Code-Executor existiert noch nicht (groesster Gap laut Session-Handoff)." });
    default: return Object.freeze({ id: "jarvis", available: true, note: "Bestehende Jarvis-Wissens-/Konversationspipeline (jarvis-console-proxy.js)." });
  }
}

function modeForTaskClass(taskClass) {
  return taskClass === "code_implementation" || taskClass === "local_action" ? "write" : "read_only";
}

function buildPrompt({ question, project, taskClass, mode, governance, sessionId }) {
  if (taskClass !== "code_analysis" && taskClass !== "code_implementation") return null;
  const lines = [
    `Originalauftrag: ${question}`,
    `Projekt: ${project.project.name} (${project.project.id})`,
    `Repo-Pfad: ${project.project.path}`,
    `Arbeitsmodus: ${mode === "write" ? "schreibend (noch nicht ausfuehrbar)" : "read-only"}`,
    "Preflight-Regeln: Branch, HEAD und Git-Status vor jeder Aenderung pruefen; keine fremden Aenderungen anfassen; nur das genannte Projekt betreffen.",
    `Governance: approvalRequired=${governance.approvalRequired}, riskLevel=${governance.riskLevel}.`,
    sessionId ? `Session-/Conversation-ID: ${sessionId}` : null,
    "Stop-Bedingungen: Kein Commit, kein Push, kein Deployment ohne ausdrueckliche Freigabe; bei Unklarheit oder fremden Locks anhalten und rueckfragen."
  ].filter(Boolean);
  return lines.join("\n");
}

// The J1.1 contract. Deliberately flat and small - see the handoff's own
// "Beispielrichtung" - and built entirely from fields the reused modules
// already compute; nothing here invents a new risk/approval model.
export function planJarvisRequest({ question, sessionId = null, sessionContext = null } = {}) {
  if (typeof question !== "string" || !question.trim()) throw new RouterError("INVALID_REQUEST", "question is required.");
  const normalizedQuestion = question.normalize("NFKC").trim();
  if (normalizedQuestion.length > MAX_TASK_LENGTH) throw new RouterError("PAYLOAD_TOO_LARGE", "question exceeds its allowed length.");

  const intent = classifyIntent({ question: normalizedQuestion, sessionContext });
  const project = extractProjectMention(normalizedQuestion);
  const taskClass = classifyTaskClass({ intent, project, question: normalizedQuestion });
  const mode = modeForTaskClass(taskClass);
  const routePlan = createRoutePlan(normalizedQuestion);
  const writeAccessRequired = mode === "write";
  const governance = Object.freeze({
    approvalRequired: routePlan.approvalRequired || writeAccessRequired,
    writeAccessRequired,
    riskLevel: routePlan.risk,
    warnings: [...routePlan.warnings]
  });
  const agent = agentForTaskClass(taskClass);
  const prompt = project.status === "resolved" ? buildPrompt({ question: normalizedQuestion, project, taskClass, mode, governance, sessionId }) : null;

  return Object.freeze({
    originalRequest: question,
    intent,
    taskType: routePlan.taskType,
    taskClass,
    project,
    mode,
    agent,
    governance,
    sessionId: sessionId || null,
    prompt
  });
}
