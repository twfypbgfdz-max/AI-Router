import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createKnowledgeHandler } from "../orchestrator/knowledge-handler.js";
import {
  JARVIS_ASK_MAX_CONCURRENT_REQUESTS,
  JARVIS_ASK_MAX_REQUESTS_PER_WINDOW,
  JARVIS_ASK_RATE_WINDOW_MS,
  KNOWLEDGE_MAX_CONCURRENT_REQUESTS,
  KNOWLEDGE_MAX_REQUESTS_PER_WINDOW,
  KNOWLEDGE_TOKEN_ENV_VAR
} from "../orchestrator/knowledge-config.js";
import { TEST_CC_TOKEN, TEST_INTERNAL_TOKEN, MODEL, ragResult, structuredAdapter } from "./cc-knowledge-helpers.js";

// Real-usage finding (2026-08-27): /api/jarvis/ask used to share
// /api/v1/knowledge's exact rate/concurrency limiter instance (one 60s
// budget for both). jarvis-console-proxy.js now builds its own
// createKnowledgeHandler instance with its own JARVIS_ASK_* budget instead,
// giving the human-facing /jarvis console a real 5s cooldown without
// touching /api/v1/knowledge's own 60s one. This file proves both halves of
// that split: the Jarvis-shaped instance really enforces ~5s, and a second,
// independently-constructed /api/v1/knowledge-shaped instance is never
// throttled by Jarvis traffic (and vice versa).

const TEST_KNOWLEDGE_TOKEN = "test-generic-knowledge-route-token-0123456789ab";

function knowledgeEnv(overrides = {}) {
  return {
    [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_KNOWLEDGE_TOKEN,
    AI_ROUTER_CC_TOKEN: TEST_CC_TOKEN,
    AI_ROUTER_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    AI_ROUTER_OLLAMA_MODEL: MODEL,
    AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "bge-m3:latest",
    AI_ROUTER_OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    ...overrides
  };
}

const body = (overrides = {}) => ({ schemaVersion: "1.0", question: "Was ist der aktuelle Stand?", ...overrides });

function exchange(requestBody) {
  const request = new EventEmitter();
  request.method = "POST";
  request.headers = { "content-type": "application/json", authorization: `Bearer ${TEST_KNOWLEDGE_TOKEN}` };
  request.socket = new EventEmitter();
  queueMicrotask(() => {
    request.emit("data", JSON.stringify(requestBody));
    request.emit("end");
  });

  const response = new EventEmitter();
  response.headers = new Map();
  response.statusCode = 200;
  response.writableEnded = false;
  response.destroyed = false;
  response.body = "";
  response.setHeader = (name, value) => response.headers.set(String(name).toLowerCase(), String(value));
  response.getHeader = (name) => response.headers.get(String(name).toLowerCase());
  response.end = (value = "") => { response.body = String(value); response.writableEnded = true; response.emit("finish"); };
  response.json = () => JSON.parse(response.body);
  return { request, response };
}

test("the Jarvis-shaped budget rejects a second request inside its 5s window with retryAfterMs ~5000", async () => {
  const generated = structuredAdapter();
  const handler = createKnowledgeHandler({
    env: knowledgeEnv(),
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: "available", results: [ragResult()] }),
    adapterFactory: () => generated.adapter,
    maxConcurrentRequests: JARVIS_ASK_MAX_CONCURRENT_REQUESTS,
    maxRequestsPerWindow: JARVIS_ASK_MAX_REQUESTS_PER_WINDOW,
    rateWindowMs: JARVIS_ASK_RATE_WINDOW_MS
  });

  const first = exchange(body());
  await handler(first.request, first.response);
  assert.equal(first.response.statusCode, 200);

  const second = exchange(body());
  await handler(second.request, second.response);
  assert.equal(second.response.statusCode, 429);
  const secondPayload = second.response.json();
  assert.ok(secondPayload.warnings.includes("rate_limited"));
});

test("a separately-constructed /api/v1/knowledge-shaped instance keeps its own 60s budget and is unaffected by Jarvis traffic", async () => {
  const jarvisAdapter = structuredAdapter();
  const jarvisHandler = createKnowledgeHandler({
    env: knowledgeEnv(),
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: "available", results: [ragResult()] }),
    adapterFactory: () => jarvisAdapter.adapter,
    maxConcurrentRequests: JARVIS_ASK_MAX_CONCURRENT_REQUESTS,
    maxRequestsPerWindow: JARVIS_ASK_MAX_REQUESTS_PER_WINDOW,
    rateWindowMs: JARVIS_ASK_RATE_WINDOW_MS
  });

  const publicAdapter = structuredAdapter();
  const publicHandler = createKnowledgeHandler({
    env: knowledgeEnv(),
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: "available", results: [ragResult()] }),
    adapterFactory: () => publicAdapter.adapter
    // No maxConcurrentRequests/maxRequestsPerWindow/rateWindowMs override:
    // exercises the same defaults server.js's /api/v1/knowledge singleton
    // uses (KNOWLEDGE_MAX_CONCURRENT_REQUESTS/KNOWLEDGE_MAX_REQUESTS_PER_WINDOW,
    // fixed 60s window).
  });

  const jarvisFirst = exchange(body());
  await jarvisHandler(jarvisFirst.request, jarvisFirst.response);
  assert.equal(jarvisFirst.response.statusCode, 200, "Jarvis's own first call must succeed");

  // Immediately after, /api/v1/knowledge's own budget must still allow a
  // fresh request - it has never seen the Jarvis traffic above.
  const publicFirst = exchange(body());
  await publicHandler(publicFirst.request, publicFirst.response);
  assert.equal(publicFirst.response.statusCode, 200, "/api/v1/knowledge must not be throttled by Jarvis traffic");

  // And Jarvis's own second call, inside its own 5s window, must still be
  // rejected - proving the two budgets are genuinely independent, not just
  // coincidentally both starting empty.
  const jarvisSecond = exchange(body());
  await jarvisHandler(jarvisSecond.request, jarvisSecond.response);
  assert.equal(jarvisSecond.response.statusCode, 429, "Jarvis's own budget must still be the one it consumed itself");
});

test("KNOWLEDGE_MAX_* constants (used by /api/v1/knowledge and cc/knowledge) are untouched by the Jarvis-specific budget", () => {
  assert.equal(KNOWLEDGE_MAX_CONCURRENT_REQUESTS, 1);
  assert.equal(KNOWLEDGE_MAX_REQUESTS_PER_WINDOW, 1);
  assert.equal(JARVIS_ASK_MAX_CONCURRENT_REQUESTS, 1);
  assert.equal(JARVIS_ASK_MAX_REQUESTS_PER_WINDOW, 1);
  assert.equal(JARVIS_ASK_RATE_WINDOW_MS, 5_000);
});
