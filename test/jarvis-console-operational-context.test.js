import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createJarvisConsoleHandler, jarvisOperationalContextProvider } from "../orchestrator/jarvis-console-proxy.js";
import { createKnowledgeHandler } from "../orchestrator/knowledge-handler.js";
import { KNOWLEDGE_TOKEN_ENV_VAR } from "../orchestrator/knowledge-config.js";
import { COCKPIT_BASE_URL_ENV_VAR, COCKPIT_READ_TOKEN_ENV_VAR } from "../orchestrator/cockpit-client.js";
import { TEST_CC_TOKEN, TEST_INTERNAL_TOKEN, MODEL } from "./cc-knowledge-helpers.js";

const TEST_KNOWLEDGE_TOKEN = "test-generic-knowledge-route-token-0123456789ab";

function fullEnv(overrides = {}) {
  return {
    [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_KNOWLEDGE_TOKEN,
    [COCKPIT_BASE_URL_ENV_VAR]: "https://cockpit.example.test",
    [COCKPIT_READ_TOKEN_ENV_VAR]: "cockpit-read-token",
    AI_ROUTER_CC_TOKEN: TEST_CC_TOKEN,
    AI_ROUTER_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    AI_ROUTER_OLLAMA_MODEL: MODEL,
    AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "bge-m3:latest",
    AI_ROUTER_OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    ...overrides
  };
}

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

test("jarvisOperationalContextProvider never calls the network for a non-day question", async () => {
  let called = false;
  const result = await jarvisOperationalContextProvider("Wie funktioniert der AI-Router?", {
    env: fullEnv(),
    fetchImpl: async () => { called = true; throw new Error("must not be called"); }
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("jarvisOperationalContextProvider calls Cockpit exactly once for a day question", async () => {
  let calls = 0;
  await jarvisOperationalContextProvider("Was ist mein Fokus heute?", {
    env: fullEnv(),
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
        text: async () => JSON.stringify({
          schemaVersion: 1,
          generatedAt: "2026-08-15T08:00:00.000Z",
          services: {
            dailyState: { status: "ok", stale: false, updatedAt: "2026-08-15T07:00:00.000Z", data: { state: { date: "2026-08-15", focus: [{ id: "f1", text: "X", done: false }] } } },
            tasks: { status: "unconfigured", stale: false, updatedAt: "", data: null },
            calendar: { status: "unconfigured", stale: false, updatedAt: "", data: null }
          }
        })
      };
    }
  });
  assert.equal(calls, 1);
});

test("end-to-end: the /jarvis proxy answers a day question purely from cockpit data, with no RAG match", async () => {
  const env = fullEnv();
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-08-15T08:00:00.000Z",
      services: {
        dailyState: { status: "ok", stale: false, updatedAt: "2026-08-15T07:00:00.000Z", data: { state: { date: "2026-08-15", focus: [{ id: "f1", text: "Plateau-Brecher testen", done: false }] } } },
        tasks: { status: "unconfigured", stale: false, updatedAt: "", data: null },
        calendar: { status: "unconfigured", stale: false, updatedAt: "", data: null }
      }
    })
  });

  const seenAdapterInputs = [];
  const knowledgeHandler = createKnowledgeHandler({
    env,
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: "no_match", results: [] }),
    adapterFactory: () => ({
      async generateText(input) {
        seenAdapterInputs.push(input);
        return { text: JSON.stringify({ answer: "Dein Fokus heute: Plateau-Brecher testen.", citedSources: [] }), usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 }, truncated: false };
      }
    }),
    operationalContextProviderFn: (question) => jarvisOperationalContextProvider(question, { env, fetchImpl })
  });

  const handler = createJarvisConsoleHandler({ env, fetchImpl, knowledgeHandler });
  const req = request({ question: "Was ist mein Fokus heute?" });
  const res = response();
  await handler(req, res);
  const payload = res.json();

  assert.equal(res.statusCode, 200);
  assert.equal(payload.state, "partial");
  assert.notEqual(payload.answer, null);
  assert.deepEqual([...payload.sources], []);
  assert.equal(seenAdapterInputs.length, 1);
  assert.ok(seenAdapterInputs[0].question.includes("Plateau-Brecher testen"));
});

// P6-B regression: real bug found during the P6-B realness check. "Was ist
// mein Fokus heute?" above is a present-state question with zero RAG
// results too, but its fake adapter always returns the same canned string
// regardless of prompt content - it only proves the wiring, never the
// actual PRESENT_STATE_NO_SOURCE_RULE/ZEITBEZUG contradiction a real model
// was observed to follow. This test asserts directly on the built prompt
// text and the response envelope: neither may still tell the model "say
// this cannot be verified" once a usable Cockpit day-context answers the
// same present-state question.
test("a present-state day question with a Cockpit context gets no refusal rule in the prompt and no current_state_not_verified warning", async () => {
  const env = fullEnv();
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-08-15T08:00:00.000Z",
      services: {
        dailyState: { status: "ok", stale: false, updatedAt: "2026-08-15T07:00:00.000Z", data: { state: { date: "2026-08-15", focus: [{ id: "f1", text: "Training", done: false }] } } },
        tasks: { status: "ok", stale: false, updatedAt: "2026-08-15T07:00:00.000Z", data: { state: { tasks: [{ text: "Projekt-Notizen sortieren", status: "open", priority: "", dueDate: "", project: "", blocked: false }] } } },
        calendar: { status: "unconfigured", stale: false, updatedAt: "", data: null }
      }
    })
  });

  const seenAdapterInputs = [];
  const knowledgeHandler = createKnowledgeHandler({
    env,
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: "no_match", results: [] }),
    adapterFactory: () => ({
      async generateText(input) {
        seenAdapterInputs.push(input);
        return { text: JSON.stringify({ answer: "Fokus: Training. Offen: Projekt-Notizen sortieren.", citedSources: [] }), usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 }, truncated: false };
      }
    }),
    operationalContextProviderFn: (question) => jarvisOperationalContextProvider(question, { env, fetchImpl })
  });

  const handler = createJarvisConsoleHandler({ env, fetchImpl, knowledgeHandler });
  const req = request({ question: "Was steht heute an?" });
  const res = response();
  await handler(req, res);
  const payload = res.json();

  assert.equal(res.statusCode, 200);
  assert.equal(payload.state, "partial");
  assert.notEqual(payload.answer, null);
  assert.ok(!payload.warnings.includes("current_state_not_verified"));
  assert.equal(seenAdapterInputs.length, 1);
  const promptText = seenAdapterInputs[0].question;
  assert.ok(!promptText.includes("keine dafür geeignete Fundstelle"));
  assert.ok(!promptText.includes("ZEITBEZUG:"));
  assert.ok(promptText.includes("Der Abschnitt TAGESKONTEXT enthält Datenwerte aus dem Felix-Cockpit"));
});
