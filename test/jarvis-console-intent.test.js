import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createJarvisConsoleHandler } from "../orchestrator/jarvis-console-proxy.js";
import { KNOWLEDGE_TOKEN_ENV_VAR } from "../orchestrator/knowledge-config.js";

const TEST_TOKEN = "test-generic-knowledge-route-token-0123456789ab";

function request(body) {
  const req = new EventEmitter();
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  req.socket = new EventEmitter();
  req.destroy = () => {};
  queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
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

function spyKnowledgeHandler(reply = { status: 200, payload: { schemaVersion: "1.0", state: "partial", answer: "A [K1]", sources: [], warnings: [] } }) {
  const seen = [];
  const handler = async (req, res) => {
    const chunks = [];
    await new Promise((resolve) => {
      req.on("data", (c) => chunks.push(c));
      req.on("end", resolve);
    });
    seen.push({ headers: req.headers, method: req.method, body: JSON.parse(Buffer.concat(chunks.map(Buffer.from)).toString("utf8")) });
    res.statusCode = reply.status;
    res.end(JSON.stringify(reply.payload));
  };
  return { handler, seen };
}

// R2 (Intent Consolidation), fail-closed action handling: /api/jarvis/ask
// recognizes an action-shaped question and answers it directly, without
// ever calling the knowledge route - see R2 spec §11/§21.

test("an action-shaped question never reaches the knowledge handler", async () => {
  const spy = spyKnowledgeHandler();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler });
  const res = response();
  await handler(request({ question: "Schick Max eine Mail." }), res);

  assert.equal(spy.seen.length, 0, "the knowledge handler must not be called for an action-shaped question");
  const payload = res.json();
  assert.equal(payload.intent, "action");
  assert.equal(payload.executionAvailable, false);
  assert.equal(typeof payload.answer, "string");
  assert.ok(payload.answer.length > 0);
});

test("Öffne Spotify. is recognized as action and not executed", async () => {
  const spy = spyKnowledgeHandler();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler });
  const res = response();
  await handler(request({ question: "Öffne Spotify." }), res);

  assert.equal(spy.seen.length, 0);
  assert.equal(res.json().intent, "action");
});

test("an ordinary knowledge question still reaches the knowledge handler exactly as before", async () => {
  const spy = spyKnowledgeHandler();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler });
  const res = response();
  await handler(request({ question: "Was sagt DEC-012?" }), res);

  assert.equal(spy.seen.length, 1);
  assert.equal(res.statusCode, 200);
});

// The proxy's documented "relays the observation payload unchanged"
// contract (jarvis-console.test.js) must survive R2: a real knowledge
// answer is never modified with an intent field.
test("a real knowledge answer is relayed byte-for-byte, with no intent field spliced in", async () => {
  const payload = { schemaVersion: "1.0", state: "partial", answer: "Antwort [K1]", sources: [{ sourceDoc: "a.md" }], warnings: ["index_stale"] };
  const spy = spyKnowledgeHandler({ status: 200, payload });
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler });
  const res = response();
  await handler(request({ question: "Frage" }), res);
  assert.deepEqual(res.json(), payload);
});
