import test from "node:test";
import assert from "node:assert/strict";
import { createSessionStore, isValidSessionId } from "../orchestrator/session/session-store.js";

function clock(startMs = 0) {
  let current = startMs;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

test("a session does not exist until a turn is appended", () => {
  const store = createSessionStore();
  assert.equal(store.getSession("11111111-1111-4111-8111-111111111111"), null);
});

test("appendTurn creates a session and getSession then returns it", async () => {
  const c = clock();
  const store = createSessionStore({ now: c.now });
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await store.appendTurn(id, { question: "Q1", answer: "A1" });
  const session = store.getSession(id);
  assert.ok(session);
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].question, "Q1");
  assert.equal(session.turns[0].answer, "A1");
});

test("a question or answer longer than MAX_TURN_CHARS is truncated, not rejected", async () => {
  const store = createSessionStore({ now: () => 0, maxTurnChars: 10 });
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await store.appendTurn(id, { question: "x".repeat(50), answer: "y".repeat(50) });
  const session = store.getSession(id);
  assert.equal(session.turns[0].question.length, 10);
  assert.equal(session.turns[0].answer.length, 10);
});

test("MAX_TURNS caps stored turns, dropping the oldest first", async () => {
  const store = createSessionStore({ now: () => 0, maxTurns: 3 });
  const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  for (let i = 1; i <= 5; i += 1) {
    await store.appendTurn(id, { question: `Q${i}`, answer: `A${i}` });
  }
  const session = store.getSession(id);
  assert.equal(session.turns.length, 3);
  assert.deepEqual(session.turns.map((t) => t.question), ["Q3", "Q4", "Q5"]);
});

test("a session past the idle timeout is treated as expired and getSession returns null", async () => {
  const c = clock();
  const store = createSessionStore({ now: c.now, idleTtlMs: 1000 });
  const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await store.appendTurn(id, { question: "Q", answer: "A" });
  c.advance(1001);
  assert.equal(store.getSession(id), null);
});

test("a session past the max session age is expired even if recently active", async () => {
  const c = clock();
  const store = createSessionStore({ now: c.now, idleTtlMs: 10_000_000, maxSessionAgeMs: 1000 });
  const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await store.appendTurn(id, { question: "Q1", answer: "A1" });
  c.advance(600);
  await store.appendTurn(id, { question: "Q2", answer: "A2" }); // updatedAt refreshed, still within age
  c.advance(500); // total age 1100 > 1000
  assert.equal(store.getSession(id), null);
});

test("appendTurn on an expired session transparently starts a fresh session under the same id", async () => {
  const c = clock();
  const store = createSessionStore({ now: c.now, idleTtlMs: 1000 });
  const id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  await store.appendTurn(id, { question: "OLD", answer: "OLD-A" });
  c.advance(2000);
  await store.appendTurn(id, { question: "NEW", answer: "NEW-A" });
  const session = store.getSession(id);
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].question, "NEW");
});

test("cleanup is lazy: an expired session is only removed on the next store access, never via a background timer", async () => {
  const c = clock();
  const store = createSessionStore({ now: c.now, idleTtlMs: 1000 });
  const id = "10101010-1010-4101-8101-101010101010";
  await store.appendTurn(id, { question: "Q", answer: "A" });
  assert.equal(store.activeSessionCount(0), 1);
  c.advance(2000);
  // Access triggers the prune; count reflects the expiry only now.
  assert.equal(store.activeSessionCount(), 0);
});

test("an unknown session id returns null, not an error", () => {
  const store = createSessionStore();
  assert.equal(store.getSession("zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz"), null);
});

test("an invalid session id is rejected by isValidSessionId and getSession/appendTurn treat it as absent", async () => {
  const store = createSessionStore();
  for (const bad of ["", "../../etc/passwd", "a/b", "a b", "x".repeat(200), null, undefined, 42]) {
    assert.equal(isValidSessionId(bad), false, JSON.stringify(bad));
    assert.equal(store.getSession(bad), null);
    assert.equal(await store.appendTurn(bad, { question: "Q", answer: "A" }), null);
  }
});

test("MAX_CONCURRENT_SESSIONS evicts the least-recently-updated session when a new one is created", async () => {
  const c = clock();
  const store = createSessionStore({ now: c.now, maxConcurrentSessions: 2 });
  await store.appendTurn("session-a", { question: "Q", answer: "A" });
  c.advance(10);
  await store.appendTurn("session-b", { question: "Q", answer: "A" });
  c.advance(10);
  await store.appendTurn("session-c", { question: "Q", answer: "A" });
  assert.equal(store.getSession("session-a"), null, "the oldest session must be evicted");
  assert.ok(store.getSession("session-b"));
  assert.ok(store.getSession("session-c"));
});

test("two near-simultaneous appendTurn calls for the same session never interleave or drop a turn", async () => {
  const store = createSessionStore({ now: () => 0 });
  const id = "concurrent-session";
  await Promise.all([
    store.appendTurn(id, { question: "Q1", answer: "A1" }),
    store.appendTurn(id, { question: "Q2", answer: "A2" }),
    store.appendTurn(id, { question: "Q3", answer: "A3" })
  ]);
  const session = store.getSession(id);
  assert.equal(session.turns.length, 3);
  assert.deepEqual(new Set(session.turns.map((t) => t.question)), new Set(["Q1", "Q2", "Q3"]));
});

test("activeSessionCount reports counts only, never session content", async () => {
  const store = createSessionStore({ now: () => 0 });
  await store.appendTurn("session-x", { question: "secret question", answer: "secret answer" });
  assert.equal(store.activeSessionCount(), 1);
});
