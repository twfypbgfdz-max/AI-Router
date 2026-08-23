import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionSummary } from "../orchestrator/session/session-summary.js";

test("returns null for a null session (no sessionId, unknown, or expired)", () => {
  assert.equal(buildSessionSummary(null), null);
});

test("returns null for a session with an empty turns array", () => {
  assert.equal(buildSessionSummary({ sessionId: "s1", createdAt: 1000, updatedAt: 1000, turns: [] }), null);
});

test("returns a frozen summary object with sessionId, timestamps and all turns", () => {
  const session = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    createdAt: 1_000,
    updatedAt: 5_000,
    turns: [
      { question: "Was ist Felix Core?", answer: "Felix Core ist das Gesamtsystem.", at: "2026-08-20T10:00:00.000Z" },
      { question: "Ist das dasselbe wie der AI-Router?", answer: "Nein, der AI-Router ist ein Baustein davon.", at: "2026-08-20T10:01:00.000Z" }
    ]
  };
  const summary = buildSessionSummary(session, { now: () => 9_999 });
  assert.equal(summary.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(summary.createdAt, new Date(1_000).toISOString());
  assert.equal(summary.updatedAt, new Date(5_000).toISOString());
  assert.equal(summary.turnCount, 2);
  assert.equal(summary.generatedAt, new Date(9_999).toISOString());
  assert.deepEqual(summary.turns, [
    { question: "Was ist Felix Core?", answer: "Felix Core ist das Gesamtsystem.", at: "2026-08-20T10:00:00.000Z" },
    { question: "Ist das dasselbe wie der AI-Router?", answer: "Nein, der AI-Router ist ein Baustein davon.", at: "2026-08-20T10:01:00.000Z" }
  ]);
  assert.ok(Object.isFrozen(summary));
  assert.ok(Object.isFrozen(summary.turns));
});

test("never calls a model or mutates the session it reads from", () => {
  const session = { sessionId: "s1", createdAt: 1, updatedAt: 2, turns: [{ question: "q", answer: "a", at: "t" }] };
  const before = JSON.stringify(session);
  buildSessionSummary(session);
  assert.equal(JSON.stringify(session), before, "buildSessionSummary must not mutate the session it summarizes");
});

test("MAX_TURNS-capped session still returns every retained turn (no further truncation)", () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({ question: `q${i}`, answer: `a${i}`, at: `t${i}` }));
  const session = { sessionId: "s1", createdAt: 1, updatedAt: 2, turns };
  const summary = buildSessionSummary(session);
  assert.equal(summary.turnCount, 20);
  assert.equal(summary.turns.length, 20);
});
