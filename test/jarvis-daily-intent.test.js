import test from "node:test";
import assert from "node:assert/strict";
import { matchJarvisDailyIntent } from "../orchestrator/jarvis-daily-intent.js";

test("matches a plain focus question", () => {
  const intent = matchJarvisDailyIntent("Was ist mein Fokus?");
  assert.ok(intent);
  assert.equal(intent.needsDailyState, true);
});

test("matches open tasks", () => {
  const intent = matchJarvisDailyIntent("Was sind meine offenen Aufgaben?");
  assert.ok(intent);
  assert.equal(intent.needsTasks, true);
  assert.equal(intent.taskView, "pending");
});

test("matches completed/done tasks", () => {
  const intent = matchJarvisDailyIntent("Was habe ich heute erledigt?");
  assert.ok(intent);
  assert.equal(intent.taskView, "done");
});

test("matches overdue", () => {
  const intent = matchJarvisDailyIntent("Was ist überfällig?");
  assert.ok(intent);
  assert.equal(intent.needsTasks, true);
  assert.equal(intent.emphasizeOverdue, true);
});

test("matches calendar/appointments", () => {
  const intent = matchJarvisDailyIntent("Welche Termine habe ich heute?");
  assert.ok(intent);
  assert.equal(intent.needsCalendar, true);
});

test("matches the generic 'was steht an' question and requests all sections", () => {
  const intent = matchJarvisDailyIntent("Was steht heute an?");
  assert.ok(intent);
  assert.equal(intent.needsDailyState, true);
  assert.equal(intent.needsTasks, true);
  assert.equal(intent.needsCalendar, true);
});

// --- required negative cases ---------------------------------------------

test("does not match a long-term training goal question", () => {
  assert.equal(matchJarvisDailyIntent("Was ist mein langfristiges Trainingsziel?"), null);
});

test("does not match a general project-status question", () => {
  assert.equal(matchJarvisDailyIntent("Wie steht Projekt X grundsätzlich?"), null);
});

test("does not match unrelated questions", () => {
  assert.equal(matchJarvisDailyIntent("Was ist DEC-001?"), null);
  assert.equal(matchJarvisDailyIntent("Wie funktioniert der AI-Router?"), null);
});

test("returns null for empty or non-string input", () => {
  assert.equal(matchJarvisDailyIntent(""), null);
  assert.equal(matchJarvisDailyIntent("   "), null);
  assert.equal(matchJarvisDailyIntent(undefined), null);
});
