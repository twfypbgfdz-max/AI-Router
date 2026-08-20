import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionContext } from "../orchestrator/session/session-context.js";

test("no session returns null", () => {
  assert.equal(buildSessionContext(null), null);
});

test("a session with no turns returns null", () => {
  assert.equal(buildSessionContext({ sessionId: "x", turns: [] }), null);
});

test("a single question/answer pairing is returned as one recent turn, no summary", () => {
  const session = { sessionId: "x", turns: [{ question: "Q1", answer: "A1" }] };
  const context = buildSessionContext(session);
  assert.equal(context.summary, null);
  assert.deepEqual(context.recentTurns, [{ question: "Q1", answer: "A1" }]);
});

test("multiple turns within the context window are all returned verbatim, in order", () => {
  const turns = [1, 2, 3].map((n) => ({ question: `Q${n}`, answer: `A${n}` }));
  const context = buildSessionContext({ sessionId: "x", turns }, { contextTurns: 6 });
  assert.equal(context.summary, null);
  assert.deepEqual(context.recentTurns.map((t) => t.question), ["Q1", "Q2", "Q3"]);
});

test("only the last N turns are returned verbatim when more than contextTurns exist", () => {
  const turns = Array.from({ length: 9 }, (_, i) => ({ question: `Q${i + 1}`, answer: `A${i + 1}` }));
  const context = buildSessionContext({ sessionId: "x", turns }, { contextTurns: 6 });
  assert.deepEqual(context.recentTurns.map((t) => t.question), ["Q4", "Q5", "Q6", "Q7", "Q8", "Q9"]);
});

test("turns older than the context window are folded into one deterministic summary line", () => {
  const turns = Array.from({ length: 9 }, (_, i) => ({ question: `Q${i + 1}`, answer: `A${i + 1}` }));
  const context = buildSessionContext({ sessionId: "x", turns }, { contextTurns: 6 });
  assert.ok(context.summary);
  assert.ok(context.summary.includes("Q1"));
  assert.ok(context.summary.includes("Q2"));
  assert.ok(context.summary.includes("Q3"));
  assert.ok(!context.summary.includes("Q4"), "a turn still in the recent window must not also appear in the summary");
});

test("the summary is fully deterministic - same input always produces the same summary text, no randomness", () => {
  const turns = Array.from({ length: 8 }, (_, i) => ({ question: `Q${i + 1}`, answer: `A${i + 1}` }));
  const a = buildSessionContext({ sessionId: "x", turns }, { contextTurns: 6 });
  const b = buildSessionContext({ sessionId: "x", turns }, { contextTurns: 6 });
  assert.equal(a.summary, b.summary);
});

test("recentTurns keeps question and answer roles distinct, never merged into one string", () => {
  const session = { sessionId: "x", turns: [{ question: "Was ist X?", answer: "X ist Y." }] };
  const context = buildSessionContext(session);
  assert.equal(context.recentTurns[0].question, "Was ist X?");
  assert.equal(context.recentTurns[0].answer, "X ist Y.");
});
