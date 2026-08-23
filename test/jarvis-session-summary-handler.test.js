import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createJarvisSessionSummaryHandler } from "../orchestrator/jarvis-session-summary-handler.js";
import { createSessionStore } from "../orchestrator/session/session-store.js";

const VALID_SESSION_ID = "11111111-1111-4111-8111-111111111111";

function request(body) {
  const req = new EventEmitter();
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  queueMicrotask(() => {
    req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function response() {
  const res = {};
  res.headers = new Map();
  res.statusCode = 200;
  res.setHeader = (n, v) => res.headers.set(String(n).toLowerCase(), String(v));
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    return res;
  };
  res.end = (v = "") => { res.body = String(v); };
  res.json = () => JSON.parse(res.body);
  return res;
}

test("a request without sessionId returns {summary: null}, never an error", async () => {
  const sessionStore = createSessionStore();
  const handler = createJarvisSessionSummaryHandler({ sessionStore });
  const res = response();
  await handler(request({}), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().summary, null);
});

test("an invalid sessionId is treated as no session, never an error", async () => {
  const sessionStore = createSessionStore();
  const handler = createJarvisSessionSummaryHandler({ sessionStore });
  const res = response();
  await handler(request({ sessionId: "../not valid/" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().summary, null);
});

test("an unknown/expired sessionId returns {summary: null}, never an error", async () => {
  const sessionStore = createSessionStore();
  const handler = createJarvisSessionSummaryHandler({ sessionStore });
  const res = response();
  await handler(request({ sessionId: VALID_SESSION_ID }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().summary, null);
});

test("a session with turns returns the full deterministic summary", async () => {
  const sessionStore = createSessionStore();
  await sessionStore.appendTurn(VALID_SESSION_ID, { question: "Was ist Felix Core?", answer: "Felix Core ist das Gesamtsystem." });
  const handler = createJarvisSessionSummaryHandler({ sessionStore });
  const res = response();
  await handler(request({ sessionId: VALID_SESSION_ID }), res);
  const { summary } = res.json();
  assert.equal(summary.sessionId, VALID_SESSION_ID);
  assert.equal(summary.turnCount, 1);
  assert.equal(summary.turns[0].question, "Was ist Felix Core?");
  assert.equal(summary.turns[0].answer, "Felix Core ist das Gesamtsystem.");
});

test("requesting a summary never mutates or evicts the session - it keeps living under its own TTL", async () => {
  const sessionStore = createSessionStore();
  await sessionStore.appendTurn(VALID_SESSION_ID, { question: "q", answer: "a" });
  const handler = createJarvisSessionSummaryHandler({ sessionStore });
  await handler(request({ sessionId: VALID_SESSION_ID }), response());
  const session = sessionStore.getSession(VALID_SESSION_ID);
  assert.ok(session, "the session must still exist after requesting its summary");
  assert.equal(session.turns.length, 1);
});

test("malformed JSON body returns 400 INVALID_REQUEST, not a crash", async () => {
  const sessionStore = createSessionStore();
  const handler = createJarvisSessionSummaryHandler({ sessionStore });
  const res = response();
  await handler(request("{not json"), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "INVALID_REQUEST");
});

test("a sessionStore.getSession that throws never crashes the handler", async () => {
  const brokenStore = { isValidSessionId: () => true, getSession: () => { throw new Error("boom"); } };
  const handler = createJarvisSessionSummaryHandler({ sessionStore: brokenStore });
  const res = response();
  await handler(request({ sessionId: VALID_SESSION_ID }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().summary, null);
});
