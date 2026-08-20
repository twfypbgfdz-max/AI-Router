import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createJarvisConsoleHandler } from "../orchestrator/jarvis-console-proxy.js";
import { createSessionStore } from "../orchestrator/session/session-store.js";
import { KNOWLEDGE_TOKEN_ENV_VAR } from "../orchestrator/knowledge-config.js";

const TEST_TOKEN = "test-generic-knowledge-route-token-0123456789ab";
const VALID_SESSION_ID = "11111111-1111-4111-8111-111111111111";

function request(body) {
  const req = new EventEmitter();
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  req.socket = new EventEmitter();
  req.destroy = () => {};
  queueMicrotask(() => {
    req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function response() {
  const res = new EventEmitter();
  res.headers = new Map();
  res.statusCode = 200;
  res.writableEnded = false;
  res.destroyed = false;
  res.body = "";
  res.setHeader = (n, v) => res.headers.set(String(n).toLowerCase(), String(v));
  res.getHeader = (n) => res.headers.get(String(n).toLowerCase());
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    return res;
  };
  res.end = (v = "") => { res.body = String(v); res.writableEnded = true; };
  res.json = () => JSON.parse(res.body);
  return res;
}

// A fake knowledgeHandler that behaves like handleKnowledgeRequest closely
// enough for these tests: it reads the internal request body, honours a
// per-call sessionContextProviderFn exactly like knowledge-handler.js does,
// and replies with a canned answer that echoes the resolved session
// context back into the answer text - this is how the tests below can
// assert on what the proxy actually threaded through, without needing a
// real Ollama call.
function fakeKnowledgeHandler({ answerText = "Antwort [K1]" } = {}) {
  const seen = [];
  const handler = async (req, res, callOptions = {}) => {
    const chunks = [];
    await new Promise((resolve) => {
      req.on("data", (c) => chunks.push(c));
      req.on("end", resolve);
    });
    const body = JSON.parse(Buffer.concat(chunks.map(Buffer.from)).toString("utf8"));
    const sessionContext = callOptions.sessionContextProviderFn ? await callOptions.sessionContextProviderFn(body.question) : null;
    seen.push({ body, sessionContext });
    res.statusCode = 200;
    res.end(JSON.stringify({ schemaVersion: "1.0", state: "partial", answer: answerText, sources: [], warnings: [] }));
  };
  return { handler, seen };
}

test("a request without sessionId works exactly as before - no session wiring at all", async () => {
  const spy = fakeKnowledgeHandler();
  const sessionStore = createSessionStore();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler, sessionStore });
  const res = response();
  await handler(request({ question: "Frage ohne Session" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(spy.seen[0].sessionContext, null);
  assert.equal(sessionStore.activeSessionCount(), 0, "no session may be created for a request without a sessionId");
});

test("sessionId is never forwarded into the internal /api/v1/knowledge request body", async () => {
  const spy = fakeKnowledgeHandler();
  const sessionStore = createSessionStore();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler, sessionStore });
  await handler(request({ question: "Frage", sessionId: VALID_SESSION_ID }), response());
  assert.deepEqual(spy.seen[0].body, { schemaVersion: "1.0", question: "Frage" });
});

test("an invalid sessionId is silently treated as no session, never an error", async () => {
  const spy = fakeKnowledgeHandler();
  const sessionStore = createSessionStore();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler, sessionStore });
  const res = response();
  await handler(request({ question: "Frage", sessionId: "../not valid/" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(spy.seen[0].sessionContext, null);
});

test("a first question with a sessionId stores the turn after a successful answer", async () => {
  const spy = fakeKnowledgeHandler({ answerText: "R1 Session, R2 Intent, R4 Action Foundation." });
  const sessionStore = createSessionStore();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler, sessionStore });
  await handler(request({ question: "Welche drei Foundation-Blöcke kommen als Nächstes?", sessionId: VALID_SESSION_ID }), response());
  const session = sessionStore.getSession(VALID_SESSION_ID);
  assert.ok(session);
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].question, "Welche drei Foundation-Blöcke kommen als Nächstes?");
  assert.equal(session.turns[0].answer, "R1 Session, R2 Intent, R4 Action Foundation.");
});

// The end-to-end reference-resolution case from the R1 spec: a second
// question in the same session must see the first turn in its model
// context (asserted deterministically on the prompt/context object handed
// to the second call, not on any particular model output).
test("a second question in the same session receives the first turn as session context", async () => {
  const spy = fakeKnowledgeHandler({ answerText: "R1 Session, R2 Intent, R4 Action Foundation." });
  const sessionStore = createSessionStore();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler, sessionStore });

  await handler(request({ question: "Welche drei Foundation-Blöcke kommen als Nächstes?", sessionId: VALID_SESSION_ID }), response());

  const secondSpy = fakeKnowledgeHandler({ answerText: "R2 ist wichtig, weil er Voraussetzung für R4 ist." });
  const secondHandler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: secondSpy.handler, sessionStore });
  await secondHandler(request({ question: "Warum ist der zweite wichtig?", sessionId: VALID_SESSION_ID }), response());

  const sessionContext = secondSpy.seen[0].sessionContext;
  assert.ok(sessionContext, "the second call must receive a non-null session context");
  assert.equal(sessionContext.recentTurns.length, 1);
  assert.equal(sessionContext.recentTurns[0].question, "Welche drei Foundation-Blöcke kommen als Nächstes?");
  assert.equal(sessionContext.recentTurns[0].answer, "R1 Session, R2 Intent, R4 Action Foundation.");
});

test("two different session ids are fully isolated from each other", async () => {
  const sessionStore = createSessionStore();
  const spyA = fakeKnowledgeHandler({ answerText: "Antwort A" });
  const handlerA = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spyA.handler, sessionStore });
  await handlerA(request({ question: "Frage A", sessionId: "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa" }), response());

  const spyB = fakeKnowledgeHandler({ answerText: "Antwort B" });
  const handlerB = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spyB.handler, sessionStore });
  await handlerB(request({ question: "Frage B", sessionId: "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb" }), response());

  assert.equal(spyB.seen[0].sessionContext, null, "session B must not see session A's turn");
});

test("session loss (unknown/expired session id) degrades cleanly - the request is still answered", async () => {
  const spy = fakeKnowledgeHandler();
  const sessionStore = createSessionStore();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler, sessionStore });
  const res = response();
  await handler(request({ question: "Frage", sessionId: "99999999-9999-4999-8999-999999999999" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(spy.seen[0].sessionContext, null);
});

test("a transport failure never writes a turn to the session", async () => {
  const sessionStore = createSessionStore();
  const failingHandler = async (req, res) => {
    await new Promise((resolve) => { req.on("data", () => {}); req.on("end", resolve); });
    res.statusCode = 503;
    res.end(JSON.stringify({ schemaVersion: "1.0", error: { code: "AUTH_NOT_CONFIGURED", message: "unavailable" } }));
  };
  const handler = createJarvisConsoleHandler({ env: {}, knowledgeHandler: failingHandler, sessionStore });
  await handler(request({ question: "Frage", sessionId: VALID_SESSION_ID }), response());
  assert.equal(sessionStore.getSession(VALID_SESSION_ID), null, "a failed request must not corrupt or seed the session");
});

test("an 'unavailable' knowledge state (no answer text) never writes a turn to the session", async () => {
  const sessionStore = createSessionStore();
  const unavailableHandler = async (req, res) => {
    await new Promise((resolve) => { req.on("data", () => {}); req.on("end", resolve); });
    res.statusCode = 200;
    res.end(JSON.stringify({ schemaVersion: "1.0", state: "unavailable", answer: null, sources: [], warnings: ["no_context_no_knowledge"] }));
  };
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: unavailableHandler, sessionStore });
  await handler(request({ question: "Frage", sessionId: VALID_SESSION_ID }), response());
  assert.equal(sessionStore.getSession(VALID_SESSION_ID), null);
});

test("a session store that throws on append never breaks an already-successful response", async () => {
  const spy = fakeKnowledgeHandler({ answerText: "Antwort" });
  const brokenStore = {
    isValidSessionId: () => true,
    getSession: () => null,
    appendTurn: async () => { throw new Error("boom"); }
  };
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler, sessionStore: brokenStore });
  const res = response();
  await handler(request({ question: "Frage", sessionId: VALID_SESSION_ID }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().answer, "Antwort");
});
