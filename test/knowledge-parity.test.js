import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCcKnowledgeHandler } from "../orchestrator/cc-knowledge-handler.js";
import { createKnowledgeHandler } from "../orchestrator/knowledge-handler.js";
import { KNOWLEDGE_TOKEN_ENV_VAR } from "../orchestrator/knowledge-config.js";
import { TEST_CC_TOKEN, TEST_INTERNAL_TOKEN, MODEL, knowledgeContext, ragResult, structuredAdapter } from "./cc-knowledge-helpers.js";

// Proves the extraction actually shares one engine instead of forking it.
// If someone later "fixes" one route by editing only its handler, these
// assertions fail - which is the whole reason cc/knowledge could be left
// unmigrated with confidence.
const TEST_KNOWLEDGE_TOKEN = "test-generic-knowledge-route-token-0123456789ab";
const QUESTION = "Darf der AI-Router eigenständig riskante Aktionen ausführen?";

function env() {
  return {
    [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_KNOWLEDGE_TOKEN,
    AI_ROUTER_CC_TOKEN: TEST_CC_TOKEN,
    AI_ROUTER_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    AI_ROUTER_OLLAMA_MODEL: MODEL,
    AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "bge-m3:latest",
    AI_ROUTER_OLLAMA_BASE_URL: "http://127.0.0.1:11434"
  };
}

function exchange(body, token) {
  const request = new EventEmitter();
  request.method = "POST";
  request.headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  request.socket = new EventEmitter();
  queueMicrotask(() => { request.emit("data", JSON.stringify(body)); request.emit("end"); });

  const response = new EventEmitter();
  response.headers = new Map();
  response.statusCode = 200;
  response.writableEnded = false;
  response.destroyed = false;
  response.body = "";
  response.setHeader = (name, value) => response.headers.set(String(name).toLowerCase(), String(value));
  response.getHeader = (name) => response.headers.get(String(name).toLowerCase());
  response.end = (value = "") => { response.body = String(value); response.writableEnded = true; };
  response.json = () => JSON.parse(response.body);
  return { request, response };
}

// Both handlers get identical retrieval results and an identical adapter,
// and generatedAt is pinned, so any difference in the payload is a real
// behavioural difference rather than timing or randomness.
async function runBoth({ results, adapterOptions } = {}) {
  const fixedNow = () => new Date("2026-08-11T12:00:00.000Z");
  const shared = {
    env: env(),
    now: fixedNow,
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: results.length ? "available" : "no_match", results }),
    adapterFactory: () => structuredAdapter(adapterOptions).adapter
  };

  const ccHandler = createCcKnowledgeHandler(shared);
  const genericHandler = createKnowledgeHandler(shared);

  const cc = exchange({ schemaVersion: "1.0", question: QUESTION }, TEST_CC_TOKEN);
  await ccHandler(cc.request, cc.response);

  const generic = exchange({ schemaVersion: "1.0", question: QUESTION }, TEST_KNOWLEDGE_TOKEN);
  await genericHandler(generic.request, generic.response);

  return { cc: cc.response, generic: generic.response };
}

test("without a context, both routes produce a byte-identical payload", async () => {
  const { cc, generic } = await runBoth({ results: [ragResult()] });
  assert.equal(cc.statusCode, 200);
  assert.equal(generic.statusCode, 200);
  assert.equal(generic.body, cc.body);
});

test("the no-basis refusal is identical on both routes", async () => {
  const { cc, generic } = await runBoth({ results: [] });
  assert.equal(generic.body, cc.body);
  assert.equal(cc.json().state, "unavailable");
});

test("the fail-closed source validation is identical on both routes", async () => {
  const { cc, generic } = await runBoth({ results: [ragResult()], adapterOptions: { citedSources: [] } });
  assert.equal(generic.body, cc.body);
  assert.deepEqual([...cc.json().warnings], ["model_source_validation_failed"]);
});

test("the action-claim block is identical on both routes", async () => {
  const { cc, generic } = await runBoth({
    results: [ragResult()],
    adapterOptions: { answer: "Ich habe den Commit erstellt. [K1]", citedSources: ["K1"] }
  });
  assert.equal(generic.body, cc.body);
  assert.deepEqual([...cc.json().warnings], ["model_action_claim_blocked"]);
});

// The one intended difference: only the Command Center route can supply a
// system context, and supplying one is what makes state "ok" reachable.
test("the only divergence is the context field, which only the CC route accepts", async () => {
  const fixedNow = () => new Date("2026-08-11T12:00:00.000Z");
  const shared = {
    env: env(),
    now: fixedNow,
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: "available", results: [ragResult()] }),
    adapterFactory: () => structuredAdapter().adapter
  };

  const cc = exchange({ schemaVersion: "1.0", question: QUESTION, context: knowledgeContext() }, TEST_CC_TOKEN);
  await createCcKnowledgeHandler(shared)(cc.request, cc.response);
  assert.equal(cc.response.json().systemContextState, "available");
  assert.equal(cc.response.json().state, "ok");

  const generic = exchange({ schemaVersion: "1.0", question: QUESTION, context: knowledgeContext() }, TEST_KNOWLEDGE_TOKEN);
  await createKnowledgeHandler(shared)(generic.request, generic.response);
  assert.equal(generic.response.statusCode, 422);
});
