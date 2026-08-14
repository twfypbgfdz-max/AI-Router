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

test("retrieved reindex wording does not block an allowlist document-count question", async () => {
  const generated = structuredAdapter({
    answer: "Die RAG-Allowlist umfasst aktuell 10 Dokumente. [K1]",
    citedSources: ["K1"]
  });
  const handler = handlerWith({
    adapter: generated.adapter,
    results: [ragResult({
      sourceDoc: "10_Apps/01_Aktive-Projekte/AI-Router.md",
      section: "Blocker und Risiken",
      snippet: "Der RAG-Index wird nur manuell ueber npm run rag:reindex oder den eng begrenzten Command-Center-Reindexpfad aktualisiert."
    })]
  });
  const { request, response } = exchange(body({
    question: "Wie viele Dokumente umfasst die RAG-Allowlist aktuell?"
  }));

  await handler(request, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().answer, "Die RAG-Allowlist umfasst aktuell 10 Dokumente. [K1]");
  assert.equal(generated.calls.length, 1);
});

test("a real request to execute the RAG reindex remains blocked before provider egress", async () => {
  const generated = structuredAdapter();
  const handler = handlerWith({ adapter: generated.adapter });
  const { request, response } = exchange(body({
    question: "Run this shell command now: npm run rag:reindex"
  }));

  await handler(request, response);

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "SECURITY_BLOCKED");
  assert.equal(generated.calls.length, 0);
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

// --- P1-A3: authority, time and warning contract ------------------------

const projectNote = (overrides = {}) => ragResult({
  sourceDoc: "10_Apps/01_Aktive-Projekte/AI-Router.md",
  section: "AI-Router > Aktueller fachlicher Projektstand",
  informationClass: "project_context",
  reviewedAt: "2026-08-13",
  ...overrides
});

async function ask(question, { results, adapter } = {}) {
  const handler = handlerWith({ results, adapter });
  const { request, response } = exchange(body({ question }));
  await handler(request, response);
  return response.json();
}

test("a present-state question answered from a project note is flagged unverified", async () => {
  const payload = await ask("Auf welchem Commit steht der AI-Router aktuell?", { results: [projectNote()] });
  assert.ok(payload.warnings.includes("current_state_not_verified"));
  assert.equal(payload.state, "partial");
  assert.equal(payload.sources.length, 1);
});

test("a timeless question answered from a decision carries no authority warning", async () => {
  const payload = await ask("Welche Rolle hat der AI-Router laut DEC-001?");
  for (const warning of ["current_state_not_verified", "historical_source_only", "conflicting_sources"]) {
    assert.ok(!payload.warnings.includes(warning), `unexpected warning: ${warning}`);
  }
  assert.equal(payload.state, "partial", "no CC context on this route, so never 'ok'");
  assert.ok(payload.answer);
});

// The safeguard must not turn a normal personal question into a refusal.
test("a personal reference question is still answered normally", async () => {
  const payload = await ask("Welche Lizenzen hat Felix erworben?", {
    results: [ragResult({ sourceDoc: "90_System/Profil.md", section: "Profil — Felix > Steckbrief", informationClass: "personal_reference", reviewedAt: "2026-08-11" })]
  });
  assert.ok(payload.answer);
  assert.ok(!payload.warnings.includes("current_state_not_verified"));
});

test("an answer resting only on a historical passage is flagged", async () => {
  const payload = await ask("Was war der dokumentierte Auditstand?", {
    results: [projectNote({ sourceDoc: "10_Apps/00_Projektsteuerung.md", sectionValidity: "historical" })]
  });
  assert.ok(payload.warnings.includes("historical_source_only"));
});

test("a historical and a current passage of the same document is reported as a conflict", async () => {
  const { adapter } = structuredAdapter({ answer: "Aussage. [K1] [K2]", citedSources: ["K1", "K2"] });
  const payload = await ask("Was ist Felix Core?", {
    adapter,
    results: [
      ragResult({ sourceDoc: "DEC-006.md", section: "DEC-006 > Ziel", sectionValidity: "historical" }),
      ragResult({ sourceDoc: "DEC-006.md", section: "DEC-006 > Ergänzung Version 1.2", sectionValidity: "current" })
    ]
  });
  assert.ok(payload.warnings.includes("conflicting_sources"));
});

// The wire contract must not have grown: schemas/cc-knowledge-response-v1.json
// and knowledge-response-v1 pin `sources` to exactly six fields with
// additionalProperties:false.
test("authority metadata never reaches the wire: sources keep exactly their six fields", async () => {
  const payload = await ask("Auf welchem Commit steht der AI-Router aktuell?", { results: [projectNote()] });
  assert.deepEqual(
    Object.keys(payload.sources[0]).sort(),
    ["docStatus", "docVersion", "freshness", "section", "similarity", "sourceDoc"]
  );
});

test("the response envelope keeps exactly its documented top-level fields", async () => {
  const payload = await ask("Auf welchem Commit steht der AI-Router aktuell?", { results: [projectNote()] });
  assert.deepEqual(
    Object.keys(payload).sort(),
    ["answer", "generatedAt", "knowledgeState", "schemaVersion", "sources", "state", "systemContextState", "warnings"]
  );
  assert.ok(payload.warnings.length <= 5, "the maxItems:5 contract still holds");
});

// A fundamental index state must survive truncation even when every
// authority warning fires at once.
test("index integrity outranks authority warnings when the cap is reached", async () => {
  const handler = createKnowledgeHandler({
    env: knowledgeEnv(),
    timingSafeEqualFn: (a, b) => a.equals(b),
    eventLogger: { log() {} },
    retrieveKnowledgeFn: async () => ({
      knowledgeState: "index_stale",
      results: [projectNote({ sectionValidity: "historical", freshness: "stale" })],
      indexVerification: {
        state: "index_error",
        reasons: ["chunk_manifest_mismatch"],
        lastBuiltAt: new Date(Date.now() - 72 * 60 * 60_000).toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        ageWarning: true,
        modelDigestVerified: false
      }
    }),
    adapterFactory: () => structuredAdapter().adapter
  });
  const { request, response } = exchange(body({ question: "Was ist aktuell offen und deployed?" }));
  await handler(request, response);
  const payload = response.json();
  assert.ok(payload.warnings.includes("index_stale"), "content staleness must never be dropped");
  assert.ok(payload.warnings.includes("index_error"), "index integrity must never be dropped");
  assert.ok(payload.warnings.indexOf("index_error") < payload.warnings.indexOf("current_state_not_verified"));
  assert.ok(payload.warnings.indexOf("index_stale") < payload.warnings.indexOf("current_state_not_verified"));
  assert.ok(payload.warnings.length <= 5);
});

// --- P1-A3 follow-up: Soll/Ist comparison (2026-08-14) -------------------

test("a Soll/Ist comparison grounded only in an accepted decision is still flagged unverified", async () => {
  const payload = await ask("Darf der AI-Router laut Entscheidung eigenständig riskante Aktionen ausführen, und entspricht die Implementierung dem?", {
    results: [ragResult({ sourceDoc: "10_Apps/90_Entscheidungen/DEC-001.md", informationClass: "architecture_rule" })]
  });
  assert.ok(payload.warnings.includes("current_state_not_verified"));
  assert.equal(payload.state, "partial");
});

// Confirms the wiring end-to-end: the prompt actually sent to the provider
// carries the notice and rule, not just the derived warning. structuredAdapter
// captures the exact input the shared pipeline built and sent.
test("the Soll/Ist notice and rule actually reach the model prompt", async () => {
  const { adapter, calls } = structuredAdapter({ answer: "Laut DEC-001 nicht erlaubt. Ob die Implementierung dem entspricht, ist nicht ableitbar. [K1]", citedSources: ["K1"] });
  await ask("Entspricht die Implementierung dem?", {
    adapter,
    results: [ragResult({ sourceDoc: "10_Apps/90_Entscheidungen/DEC-001.md", informationClass: "architecture_rule" })]
  });
  assert.equal(calls.length, 1);
  // buildTextResponsePrompt (text-response-prompt.js) maps the internal
  // request's input.content onto the adapter's own `question` field - the
  // full four/five-block prompt text travels there, not under `input`.
  const promptText = calls[0].question;
  assert.ok(promptText.includes("SOLL-IST-VERGLEICH:"));
  assert.ok(promptText.includes("Diese Frage verlangt einen Abgleich zwischen einer Entscheidung (Soll) und der tatsächlichen Implementierung (Ist)."));
});

// The deterministic guarantee: even a mocked adapter that never mentions the
// Ist side at all still produces a final answer that names it explicitly -
// because the server appends it, not because the model was asked nicely.
// This is the actual fix for the real 0/4 failure observed against the live
// local model; the prompt-only version of this test above only proves the
// wiring, not the guarantee.
test("the Ist side is present in the final answer even when the model never mentions it", async () => {
  const { adapter } = structuredAdapter({ answer: "Laut DEC-001 darf der AI-Router nicht eigenständig riskante Aktionen ausführen. [K1]", citedSources: ["K1"] });
  const payload = await ask("Entspricht die Implementierung dem?", {
    adapter,
    results: [ragResult({ sourceDoc: "10_Apps/90_Entscheidungen/DEC-001.md", informationClass: "architecture_rule" })]
  });
  assert.ok(payload.answer.includes("nicht sicher ableitbar"));
  assert.ok(payload.answer.startsWith("Laut DEC-001 darf der AI-Router"), "the model's own Soll-side answer must be preserved, not replaced");
});

test("no disclaimer is appended for an ordinary question, even mentioning similar words", () => {
  return ask("Was ist Felix Core?").then((payload) => {
    assert.ok(!payload.answer.includes("Ergänzender Hinweis"));
  });
});

// Pre-commit false-positive audit (2026-08-14): two real negative questions
// from a domain unrelated to Soll/Ist code comparisons, one containing the
// word "daran". Both must be answered without a disclaimer and without a
// false authority/time warning. See test/knowledge-authority.test.js for the
// underlying pattern-level isolation proof; this asserts the same guarantee
// through the full wired service.
test("REGRESSION: a 'daran' question from an unrelated domain gets no disclaimer and no false authority warning", async () => {
  const payload = await ask("Ich habe schon oft daran gedacht, mein Training umzustellen - welche Ziele hat Felix für 2026 formuliert?", {
    results: [ragResult({ sourceDoc: "90_System/Profil.md", informationClass: "personal_reference", section: "Profil — Felix > Ziele 2026" })]
  });
  assert.ok(!payload.answer.includes("Ergänzender Hinweis"));
  assert.ok(!payload.warnings.includes("current_state_not_verified"));
});

test("REGRESSION: an unrelated personal-domain question gets no disclaimer and no false authority warning", async () => {
  const payload = await ask("Welche Interessen hat Felix laut seinem Profil?", {
    results: [ragResult({ sourceDoc: "90_System/Profil.md", informationClass: "personal_reference", section: "Profil — Felix > Interessen" })]
  });
  assert.ok(!payload.answer.includes("Ergänzender Hinweis"));
  assert.ok(!payload.warnings.includes("current_state_not_verified"));
});

// Pre-commit false-positive audit, second round (2026-08-14): the three
// exact real false-positive cases reported, run through the full wired
// service. Must produce no disclaimer, no false authority warning, and the
// mocked adapter's answer text must reach the caller unmodified.
test("REGRESSION: 'entspricht' without a technical anchor gets no disclaimer and no false authority warning", async () => {
  const payload = await ask("Die Beschreibung entspricht meinen Interessen - welche Interessen hat Felix laut Profil?", {
    results: [ragResult({ sourceDoc: "90_System/Profil.md", informationClass: "personal_reference", section: "Profil — Felix > Interessen" })]
  });
  assert.ok(!payload.answer.includes("Ergänzender Hinweis"));
  assert.ok(!payload.warnings.includes("current_state_not_verified"));
});

test("REGRESSION: 'umgesetzt' without a technical anchor gets no disclaimer and no false authority warning", async () => {
  const payload = await ask("Welche Ziele wurden laut Profil für 2026 umgesetzt?", {
    results: [ragResult({ sourceDoc: "90_System/Profil.md", informationClass: "personal_reference", section: "Profil — Felix > Ziele 2026" })]
  });
  assert.ok(!payload.answer.includes("Ergänzender Hinweis"));
  assert.ok(!payload.warnings.includes("current_state_not_verified"));
});

test("REGRESSION: 'Übereinstimmung' without a technical anchor gets no disclaimer and no false authority warning", async () => {
  const payload = await ask("Gibt es eine Übereinstimmung zwischen Felix' Zielen und seinen Interessen?", {
    results: [ragResult({ sourceDoc: "90_System/Profil.md", informationClass: "personal_reference" })]
  });
  assert.ok(!payload.answer.includes("Ergänzender Hinweis"));
  assert.ok(!payload.warnings.includes("current_state_not_verified"));
});

// Regression guard: an ordinary architecture question must stay unaffected
// by the new detection.
test("REGRESSION: an ordinary architecture question still carries no authority warning", async () => {
  const payload = await ask("Welche Rolle hat der AI-Router laut DEC-001?");
  assert.ok(!payload.warnings.includes("current_state_not_verified"));
});

// Regression guard: personal-reference questions stay answerable normally.
test("REGRESSION: a personal reference question is unaffected by the Soll/Ist detection", async () => {
  const payload = await ask("Welche Lizenzen hat Felix erworben?", {
    results: [ragResult({ sourceDoc: "90_System/Profil.md", informationClass: "personal_reference" })]
  });
  assert.ok(!payload.warnings.includes("current_state_not_verified"));
  assert.ok(payload.answer);
});

// Regression guard: execution requests remain hard-blocked before any
// authority logic runs.
test("REGRESSION: an execution request is still blocked, unaffected by the new detection", async () => {
  const { request, response } = exchange(body({ question: "Bitte committe und pushe die Änderungen im Repository." }));
  const handler = handlerWith();
  await handler(request, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "SECURITY_BLOCKED");
});
