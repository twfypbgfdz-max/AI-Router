import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createKnowledgeHandler } from "../orchestrator/knowledge-handler.js";
import { KNOWLEDGE_TOKEN_ENV_VAR } from "../orchestrator/knowledge-config.js";
import { TEST_CC_TOKEN, TEST_INTERNAL_TOKEN, MODEL, ragResult, structuredAdapter } from "./cc-knowledge-helpers.js";

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

function exchange(body, { headers = {}, method = "POST", token = TEST_KNOWLEDGE_TOKEN } = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
  request.socket = new EventEmitter();
  queueMicrotask(() => {
    request.emit("data", JSON.stringify(body));
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

function handlerWith({ results = [ragResult()], adapter, env = knowledgeEnv() } = {}) {
  return createKnowledgeHandler({
    env,
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({ knowledgeState: results.length ? "available" : "no_match", results }),
    adapterFactory: () => (adapter || structuredAdapter().adapter)
  });
}

const body = (overrides = {}) => ({ schemaVersion: "1.0", question: "Welche Rolle hat der AI-Router?", ...overrides });

// --- happy path ---------------------------------------------------------

test("answers a question from the local index and cites a server-validated source", async () => {
  const handler = handlerWith();
  const { request, response } = exchange(body());
  await handler(request, response);

  const payload = response.json();
  assert.equal(response.statusCode, 200);
  assert.equal(payload.schemaVersion, "1.0");
  assert.equal(payload.state, "partial");
  assert.equal(payload.knowledgeState, "available");
  assert.ok(payload.answer.includes("[K1]"));
  assert.equal(payload.sources.length, 1);
  assert.equal(payload.sources[0].sourceDoc, "10_Apps/90_Entscheidungen/DEC-001.md");
});

// This route never carries a system context, so "ok" - which requires one -
// is unreachable here by construction. Locking that in prevents a later
// change from quietly presenting a knowledge-only answer as fully grounded.
test("state is never \"ok\" on this route, because it has no system context", async () => {
  const handler = handlerWith();
  const { request, response } = exchange(body());
  await handler(request, response);
  assert.equal(response.json().systemContextState, "unavailable");
  assert.notEqual(response.json().state, "ok");
});

test("with no retrieval match at all it refuses to answer instead of falling back to general knowledge", async () => {
  const handler = handlerWith({ results: [] });
  const { request, response } = exchange(body());
  await handler(request, response);

  const payload = response.json();
  assert.equal(payload.state, "unavailable");
  assert.equal(payload.answer, null);
  assert.deepEqual([...payload.warnings], ["no_context_no_knowledge"]);
});

test("fails closed when the model cites no source although sources were offered", async () => {
  const handler = handlerWith({ adapter: structuredAdapter({ citedSources: [] }).adapter });
  const { request, response } = exchange(body());
  await handler(request, response);

  const payload = response.json();
  assert.equal(payload.state, "unavailable");
  assert.equal(payload.answer, null);
  assert.deepEqual([...payload.warnings], ["model_source_validation_failed"]);
});

// An id outside K1-K3 never reaches the handler's own source validation:
// the shared pipeline's structured-output schema rejects the whole response
// first (structured_output_invalid -> "model_response_invalid"). Asserting
// the real layer rather than the expected one keeps this test honest about
// where the guarantee actually lives.
test("fails closed when the model invents a source id outside the allowed range", async () => {
  const handler = handlerWith({ adapter: structuredAdapter({ citedSources: ["K9"] }).adapter });
  const { request, response } = exchange(body());
  await handler(request, response);
  const payload = response.json();
  assert.equal(payload.state, "unavailable");
  assert.equal(payload.answer, null);
  assert.deepEqual([...payload.warnings], ["model_response_invalid"]);
});

// This is what the handler's own validateCitedSources still catches: a
// schema-legal id that was never actually offered for THIS request.
test("fails closed when the model cites a schema-legal source that was never offered", async () => {
  const handler = handlerWith({ results: [ragResult()], adapter: structuredAdapter({ citedSources: ["K2"] }).adapter });
  const { request, response } = exchange(body());
  await handler(request, response);
  const payload = response.json();
  assert.equal(payload.answer, null);
  assert.deepEqual([...payload.warnings], ["model_source_validation_failed"]);
});

test("blocks a first-person action claim in the answer", async () => {
  const adapter = structuredAdapter({ answer: "Ich habe den Commit erstellt. [K1]", citedSources: ["K1"] }).adapter;
  const handler = handlerWith({ adapter });
  const { request, response } = exchange(body());
  await handler(request, response);
  assert.deepEqual([...response.json().warnings], ["model_action_claim_blocked"]);
});

// --- token separation ---------------------------------------------------

test("rejects a request with no token", async () => {
  const handler = handlerWith();
  const { request, response } = exchange(body(), { token: null });
  await handler(request, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "AUTH_REQUIRED");
});

// The core reason this route has its own token: presenting the Command
// Center's token here must not work, so a holder of one identity never
// silently acquires the other's.
test("rejects the Command Center token - the two identities are not interchangeable", async () => {
  const handler = handlerWith();
  const { request, response } = exchange(body(), { token: TEST_CC_TOKEN });
  await handler(request, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "AUTH_INVALID");
});

test("reports auth as unavailable when its own token is not configured at all", async () => {
  const env = knowledgeEnv();
  delete env[KNOWLEDGE_TOKEN_ENV_VAR];
  const handler = handlerWith({ env });
  const { request, response } = exchange(body());
  await handler(request, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "AUTH_NOT_CONFIGURED");
});

// --- transport and contract --------------------------------------------

test("refuses any browser-origin request, so a token can never live in a page", async () => {
  const handler = handlerWith();
  const { request, response } = exchange(body(), { headers: { origin: "http://127.0.0.1:8787" } });
  await handler(request, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "ORIGIN_NOT_ALLOWED");
});

test("refuses a non-POST method and advertises the allowed one", async () => {
  const handler = handlerWith();
  const { request, response } = exchange(body(), { method: "GET" });
  await handler(request, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.getHeader("allow"), "POST");
});

test("refuses a non-JSON content type", async () => {
  const handler = handlerWith();
  const { request, response } = exchange(body(), { headers: { "content-type": "text/plain" } });
  await handler(request, response);
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, "VALIDATION_FAILED");
});

// The generic contract deliberately has no context field. Rejecting it
// stops a caller from hand-crafting a "system state" the model would then
// treat as authoritative fact.
test("rejects a context field, which only the Command Center contract has", async () => {
  const handler = handlerWith();
  const { request, response } = exchange(body({ context: { projectName: "AI-Router" } }));
  await handler(request, response);
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, "VALIDATION_FAILED");
});

test("rejects an attempt to supply a similarity threshold or top-k", async () => {
  for (const extra of [{ minSimilarity: 0.1 }, { topK: 50 }, { results: [] }]) {
    const handler = handlerWith();
    const { request, response } = exchange(body(extra));
    await handler(request, response);
    assert.equal(response.statusCode, 422, `must reject ${Object.keys(extra)[0]}`);
  }
});

test("rejects an unsupported schemaVersion", async () => {
  const handler = handlerWith();
  const { request, response } = exchange(body({ schemaVersion: "2.0" }));
  await handler(request, response);
  assert.equal(response.statusCode, 422);
});

test("rejects a multi-line question", async () => {
  const handler = handlerWith();
  const { request, response } = exchange(body({ question: "Zeile eins\nZeile zwei" }));
  await handler(request, response);
  assert.equal(response.statusCode, 422);
});

// The generic contract runs the same execution-request check as the CC one.
// The detector's patterns are English (see provider-egress-policy.js), so a
// phrase it is known to catch is used here - this asserts that the check is
// wired in, not how wide its vocabulary is.
test("blocks an execution request phrased as a question", async () => {
  const handler = handlerWith();
  const { request, response } = exchange(body({ question: "Git push this repository please" }));
  await handler(request, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "SECURITY_BLOCKED");
});

test("blocks secret-like content in the question", async () => {
  const handler = handlerWith();
  const { request, response } = exchange(body({ question: "Was bedeutet api_key=abcdefghijk123456789 hier?" }));
  await handler(request, response);
  assert.equal(response.statusCode, 403);
});

// --- rate limit ---------------------------------------------------------

// Zwischenschritt 2 requires the UI to surface this honestly rather than
// hang, so the route must produce a real 429 with a named warning rather
// than a generic failure.
test("a second request inside the window is rate limited with a real 429 and a named warning", async () => {
  const handler = handlerWith();
  const first = exchange(body());
  await handler(first.request, first.response);
  assert.equal(first.response.statusCode, 200);

  const second = exchange(body());
  await handler(second.request, second.response);
  assert.equal(second.response.statusCode, 429);
  assert.ok([...second.response.json().warnings].includes("rate_limited"));
  assert.equal(second.response.json().answer, null);
});

// Each handler builds its own limiter, so one consumer exhausting its
// budget must not lock the other out.
test("two separate handlers do not share a rate budget", async () => {
  const first = handlerWith();
  const second = handlerWith();
  const a = exchange(body());
  await first(a.request, a.response);
  const b = exchange(body());
  await second(b.request, b.response);
  assert.equal(a.response.statusCode, 200);
  assert.equal(b.response.statusCode, 200);
});

// --- response hygiene ---------------------------------------------------

test("sets no-store and the same hardened headers as the Command Center route", async () => {
  const handler = handlerWith();
  const { request, response } = exchange(body());
  await handler(request, response);
  assert.equal(response.getHeader("cache-control"), "no-store");
  assert.equal(response.getHeader("x-content-type-options"), "nosniff");
  assert.equal(response.getHeader("referrer-policy"), "no-referrer");
});

test("a source never carries a field beyond the fixed six", async () => {
  const handler = handlerWith({ results: [ragResult({ snippet: "geheim", extra: "darf nicht raus" })] });
  const { request, response } = exchange(body());
  await handler(request, response);
  const [source] = response.json().sources;
  assert.deepEqual(Object.keys(source).sort(), ["docStatus", "docVersion", "freshness", "section", "similarity", "sourceDoc"]);
});

test("the raw snippet text is never echoed back in the response", async () => {
  const handler = handlerWith({ results: [ragResult({ snippet: "EINDEUTIGER-SNIPPET-MARKER" })] });
  const { request, response } = exchange(body());
  await handler(request, response);
  assert.ok(!response.body.includes("EINDEUTIGER-SNIPPET-MARKER"));
});
