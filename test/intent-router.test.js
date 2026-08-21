import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, INTENT_CONTEXT_POLICY } from "../orchestrator/intent/intent-router.js";
import { INTENT_TYPES } from "../orchestrator/intent/intent-types.js";

function sessionWith(...questions) {
  return Object.freeze({
    summary: null,
    recentTurns: Object.freeze(questions.map((question) => ({ question, answer: "..." })))
  });
}

// --- R2 spec §14: one representative case per intent -----------------------

test("knowledge: DEC question", () => {
  const result = classifyIntent({ question: "Was sagt DEC-012?" });
  assert.equal(result.intent, "knowledge");
});

test("knowledge: architecture question", () => {
  const result = classifyIntent({ question: "Was ist Felix Core?" });
  assert.equal(result.intent, "knowledge");
});

test("operational: today overview", () => {
  const result = classifyIntent({ question: "Was steht heute an?" });
  assert.equal(result.intent, "operational");
  assert.equal(result.confidence, "high");
});

test("operational: open tasks today", () => {
  const result = classifyIntent({ question: "Welche Aufgaben habe ich heute?" });
  assert.equal(result.intent, "operational");
});

test("system: is the router running", () => {
  const result = classifyIntent({ question: "Läuft der AI-Router?" });
  assert.equal(result.intent, "system");
});

test("system: is whisper active", () => {
  const result = classifyIntent({ question: "Ist Whisper aktiv?" });
  assert.equal(result.intent, "system");
});

test("action: send a mail", () => {
  const result = classifyIntent({ question: "Schick eine Mail an Max." });
  assert.equal(result.intent, "action");
  assert.equal(result.confidence, "high");
});

test("action: open an app", () => {
  const result = classifyIntent({ question: "Öffne Spotify." });
  assert.equal(result.intent, "action");
});

test("action: delete a file", () => {
  const result = classifyIntent({ question: "Lösch diese Datei." });
  assert.equal(result.intent, "action");
});

test("conversation: bare 'Warum?' with an active session", () => {
  const result = classifyIntent({ question: "Warum?", sessionContext: sessionWith("Was ist Felix Core?") });
  assert.equal(result.intent, "conversation");
});

test("conversation: 'Was war der zweite Punkt?' with an active session", () => {
  const result = classifyIntent({ question: "Was war der zweite Punkt?", sessionContext: sessionWith("Was ist Felix Core?") });
  assert.equal(result.intent, "conversation");
});

test("conversation: full-sentence reference question with an active session (R2 spec §16)", () => {
  const result = classifyIntent({ question: "Warum ist der zweite wichtig?", sessionContext: sessionWith("Welche Foundation-Schritte fehlen noch?") });
  assert.equal(result.intent, "conversation");
});

test("conversation: bare 'Warum?' WITHOUT a session degrades to knowledge, never hallucinated", () => {
  const result = classifyIntent({ question: "Warum?" });
  assert.equal(result.intent, "knowledge");
  assert.equal(result.confidence, "low");
});

// --- R2 spec §15: ambiguity/priority tests ----------------------------------

test("ambiguity: 'sagen' does not distract from a real system question", () => {
  const result = classifyIntent({ question: "Kannst du mir sagen, ob der Router läuft?" });
  assert.equal(result.intent, "system");
});

test("ambiguity: meta-question about an action keyword stays knowledge", () => {
  const result = classifyIntent({ question: "Was bedeutet mail:send?" });
  assert.equal(result.intent, "knowledge");
});

test("ambiguity: meta-question about a destructive rule stays knowledge, not action", () => {
  const result = classifyIntent({ question: "Warum soll Jarvis keine Dateien löschen?" });
  assert.equal(result.intent, "knowledge");
});

test("ambiguity: 'Zeig mir meine Aufgaben' is operational, not action", () => {
  const result = classifyIntent({ question: "Zeig mir meine Aufgaben." });
  assert.equal(result.intent, "operational");
});

test("ambiguity: 'Lösch meine Aufgaben' is action even though it also looks operational", () => {
  const result = classifyIntent({ question: "Lösch meine Aufgaben." });
  assert.equal(result.intent, "action");
});

// --- route context override -------------------------------------------------

test("explicit route context wins over any text heuristic", () => {
  const today = classifyIntent({ question: "Was ist DEC-001?", routeContext: { route: "today" } });
  assert.equal(today.intent, "operational");
  const system = classifyIntent({ question: "Was ist DEC-001?", routeContext: { route: "system" } });
  assert.equal(system.intent, "system");
});

// --- structural guarantees ---------------------------------------------------

test("always exactly one primary intent from the fixed intent set", () => {
  const questions = [
    "Was sagt DEC-012?",
    "Was steht heute an?",
    "Läuft der AI-Router?",
    "Schick eine Mail an Max.",
    "Warum?"
  ];
  for (const question of questions) {
    const result = classifyIntent({ question, sessionContext: sessionWith("vorherige Frage") });
    assert.ok(INTENT_TYPES.includes(result.intent), `unexpected intent for "${question}": ${result.intent}`);
    assert.equal(typeof result.confidence, "string");
    assert.equal(typeof result.reason, "string");
  }
});

test("returns a degraded knowledge default for empty/non-string input", () => {
  assert.equal(classifyIntent({ question: "" }).intent, "knowledge");
  assert.equal(classifyIntent({ question: undefined }).intent, "knowledge");
  assert.equal(classifyIntent({}).intent, "knowledge");
});

test("context policy is defined for every intent type and only marks real providers", () => {
  for (const intent of INTENT_TYPES) {
    const policy = INTENT_CONTEXT_POLICY[intent];
    assert.ok(policy, `missing context policy for ${intent}`);
    assert.equal(policy.session, true);
  }
  assert.equal(INTENT_CONTEXT_POLICY.knowledge.rag, true);
  assert.equal(INTENT_CONTEXT_POLICY.operational.operational, true);
  assert.equal(INTENT_CONTEXT_POLICY.system.system, true);
});
