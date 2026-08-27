import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createJarvisConsoleHandler } from "../orchestrator/jarvis-console-proxy.js";
import { KNOWLEDGE_TOKEN_ENV_VAR } from "../orchestrator/knowledge-config.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = fs.readFileSync(path.join(REPO_ROOT, "01_APP", "jarvis-console.html"), "utf8");
const TEST_TOKEN = "test-generic-knowledge-route-token-0123456789ab";

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
  // http-utils.js's sendJson writes the status line via writeHead, so the
  // fake mirrors the real ServerResponse surface rather than a subset.
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    return res;
  };
  res.end = (v = "") => { res.body = String(v); res.writableEnded = true; };
  res.json = () => JSON.parse(res.body);
  return res;
}

// Captures what the proxy hands to the knowledge route, so the test can
// assert on the internal request rather than guessing.
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

// --- proxy behaviour ----------------------------------------------------

test("attaches the knowledge token server-side and sends no browser origin", async () => {
  const spy = spyKnowledgeHandler();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler });
  const res = response();
  await handler(request({ question: "Wer darf ins Sheet schreiben?" }), res);

  assert.equal(spy.seen.length, 1);
  assert.equal(spy.seen[0].headers.authorization, `Bearer ${TEST_TOKEN}`);
  assert.equal(spy.seen[0].headers.origin, undefined);
  assert.equal(res.statusCode, 200);
});

// The page must never learn the token, otherwise the whole server-side
// bridge is pointless.
test("the token never appears in the response sent to the page", async () => {
  const spy = spyKnowledgeHandler();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler });
  const res = response();
  await handler(request({ question: "Frage" }), res);
  assert.ok(!res.body.includes(TEST_TOKEN));
});

// schemaVersion is filled in by the server so a stale cached page cannot
// pin an old contract version.
test("supplies schemaVersion itself and forwards only the question", async () => {
  const spy = spyKnowledgeHandler();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler });
  await handler(request({ question: "Frage", schemaVersion: "9.9", context: { projectName: "x" } }), response());
  assert.deepEqual(spy.seen[0].body, { schemaVersion: "1.0", question: "Frage" });
});

// R1 (Session/Context Manager): a sessionId in the page's request body must
// never reach the /api/v1/knowledge contract this proxy carries - it is
// threaded through a separate, third argument instead (see
// jarvis-console-session.test.js for the session-wiring behaviour itself).
test("a sessionId in the request body is never forwarded into the internal knowledge request", async () => {
  const spy = spyKnowledgeHandler();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler });
  await handler(request({ question: "Frage", sessionId: "11111111-1111-4111-8111-111111111111" }), response());
  assert.deepEqual(spy.seen[0].body, { schemaVersion: "1.0", question: "Frage" });
});

test("relays the observation payload unchanged", async () => {
  const payload = { schemaVersion: "1.0", state: "partial", answer: "Antwort [K1]", sources: [{ sourceDoc: "a.md" }], warnings: ["index_stale"] };
  const spy = spyKnowledgeHandler({ status: 200, payload });
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler });
  const res = response();
  await handler(request({ question: "Frage" }), res);
  assert.deepEqual(res.json(), payload);
});

// The rate limit has to reach the page as a real 429 so the UI can show a
// countdown instead of a dead click or a raw error.
test("relays a 429 rate limit as a real 429 with its warning intact", async () => {
  const payload = { schemaVersion: "1.0", state: "unavailable", answer: null, sources: [], warnings: ["rate_limited"] };
  const spy = spyKnowledgeHandler({ status: 429, payload });
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler });
  const res = response();
  await handler(request({ question: "Frage" }), res);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.json().warnings, ["rate_limited"]);
});

test("relays an auth failure instead of hiding it", async () => {
  const payload = { schemaVersion: "1.0", error: { code: "AUTH_NOT_CONFIGURED", message: "Internal authentication is unavailable." } };
  const spy = spyKnowledgeHandler({ status: 503, payload });
  const handler = createJarvisConsoleHandler({ env: {}, knowledgeHandler: spy.handler });
  const res = response();
  await handler(request({ question: "Frage" }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, "AUTH_NOT_CONFIGURED");
});

test("rejects a body that is not valid JSON", async () => {
  const spy = spyKnowledgeHandler();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler });
  const res = response();
  await handler(request("{ kaputt"), res);
  assert.equal(res.statusCode, 400);
  assert.equal(spy.seen.length, 0, "a malformed body must never reach the knowledge route");
});

// A missing question becomes an empty string and is rejected downstream by
// the knowledge contract - the proxy deliberately does not validate itself,
// so there is only one place where the rules live.
test("forwards an empty question rather than inventing its own validation", async () => {
  const spy = spyKnowledgeHandler();
  const handler = createJarvisConsoleHandler({ env: { [KNOWLEDGE_TOKEN_ENV_VAR]: TEST_TOKEN }, knowledgeHandler: spy.handler });
  await handler(request({ notAQuestion: true }), response());
  assert.equal(spy.seen[0].body.question, "");
});

// --- the page itself ----------------------------------------------------

test("the page still performs no action beyond its own two local endpoints", () => {
  assert.ok(!/\/api\/v1\/cc\//.test(PAGE), "the page must never address a Command Center route");
  assert.ok(!/reindex/i.test(PAGE) || !/fetch\([^)]*reindex/i.test(PAGE), "the page must not trigger a reindex");
});

// Voice v1, step 1: local speech-to-text is now allowed, but only via a
// client-side WAV encoder over Web Audio - never the browser's built-in
// SpeechRecognition (routed through a vendor cloud service in Chrome) and
// never MediaRecorder (its webm/opus output needs ffmpeg on whisper-server
// to decode, which this page cannot assume is enabled).
test("voice input uses local WAV recording, never a browser cloud speech API", () => {
  assert.ok(/getUserMedia/.test(PAGE), "the mic button must use getUserMedia");
  assert.ok(!/SpeechRecognition|webkitSpeechRecognition/i.test(PAGE), "no browser cloud speech recognition API");
  assert.ok(!/MediaRecorder/.test(PAGE), "no MediaRecorder - its compressed output needs ffmpeg on whisper-server");
});

// U3: the page also talks to /api/runs/... now (run status, reattach, and
// the existing R9 approval BFF), reusing the same run/history endpoints the
// pre-existing test UI (01_APP/tests/ai-router-v0_13-test.html) already
// calls - no new bridge, no knowledge/STT/TTS backend touched directly.
// "/api/runs/" appears twice (GET /api/runs/:id in pollRun, and the
// approval BFF POST /api/runs/:id/approval/ui in decideApproval) because
// both build the id-scoped URL via string concatenation rather than a
// literal, so the regex below only captures the literal prefix.
// "/api/jarvis/system" appears twice for the same reason /api/runs/ does -
// two independent, justified call sites, not scope creep: the System-tab's
// own on-demand fetch (loadSystem(), unchanged), and (2026-08-27)
// refreshJarvisReadiness()'s own fetch, used to fold the Command Center
// signal into the top-level readiness badge (see computeReadinessLevel1).
// Still the same eleven distinct server-side bridges, no new one added.
test("the page talks only to its own eleven server-side bridges, never to a knowledge, STT or TTS backend directly", () => {
  const fetchTargets = [...PAGE.matchAll(/fetch\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fetchTargets.sort(), ["/api/jarvis/ask", "/api/jarvis/ready", "/api/jarvis/session/summary", "/api/jarvis/speak", "/api/jarvis/system", "/api/jarvis/system", "/api/jarvis/today", "/api/jarvis/transcribe", "/api/jarvis/voice-status", "/api/runs/", "/api/runs/", "/api/runs/latest"]);
});

// --- P2-C: readiness display --------------------------------------------

test("the page fetches /api/jarvis/ready exactly once on load, not via polling or a socket", () => {
  assert.equal((PAGE.match(/fetch\(\s*"\/api\/jarvis\/ready"/g) || []).length, 1);
  assert.ok(!/setInterval|setTimeout/.test(PAGE.match(/Jarvis-Readiness[\s\S]*?\}\)\(\);/)?.[0] || ""), "no polling around the readiness fetch");
  assert.ok(!/new WebSocket/.test(PAGE), "no WebSocket anywhere on the page");
});

// The honest Voice status (Piper/Whisper) is a deliberately separate fetch
// from /api/jarvis/ready - see orchestrator/jarvis-voice-status.js for why
// the actual Whisper reachability ping must not live inside the
// network-ping-free readiness check. Same "once on load, no polling"
// contract as jarvis/ready above.
test("the page fetches /api/jarvis/voice-status exactly once on load, not via polling or a socket", () => {
  assert.equal((PAGE.match(/fetch\(\s*"\/api\/jarvis\/voice-status"/g) || []).length, 1);
  assert.ok(!/setInterval|setTimeout/.test(PAGE.match(/Voice-Status \(einmalig[\s\S]*?\}\)\(\);/)?.[0] || ""), "no polling around the voice-status fetch");
});

// Real-usage finding (2026-08-27): the old three-state wording ("Jarvis
// bereit"/"teilweise bereit"/"nicht verfügbar") never distinguished "voice
// broken, knowledge fine" from "live/side services degraded, knowledge
// fine" - both looked identical to "teilweise bereit". Four plain-language
// Level-1 labels now cover that split; technical reason codes stay in the
// existing "Technische Details zur Bereitschaft" disclosure, never here.
test("the page renders all four readiness states in plain German using the existing badge/notice styling", () => {
  assert.ok(PAGE.includes('"Bereit"'));
  assert.ok(PAGE.includes('"Teilweise verfügbar"'));
  assert.ok(PAGE.includes('"Wissensmodus verfügbar"'));
  assert.ok(PAGE.includes('"Offline"'));
  assert.ok(/<span class="badge[^>]*id="jarvis-ready-badge"/.test(PAGE), "the readiness indicator reuses the existing .badge styling");
});

test("the page translates every readiness reason code the closed vocabulary can emit", () => {
  for (const reason of [
    "answer_provider_unavailable", "answer_model_unavailable", "embedding_model_unavailable",
    "index_missing", "index_stale", "index_incompatible", "index_error",
    "WHISPER_NOT_CONFIGURED", "PIPER_NOT_CONFIGURED", "PIPER_UNAVAILABLE"
  ]) {
    assert.ok(PAGE.includes(`${reason}:`), `readiness reason ${reason} needs a plain-language explanation`);
  }
});

test("voice buttons are never disabled or hidden based on readiness", () => {
  const readinessBlockMatch = PAGE.match(/Jarvis-Readiness[\s\S]*?\}\)\(\);/);
  assert.ok(readinessBlockMatch, "the readiness block must exist");
  assert.ok(!/micBtn\.(disabled|hidden)/.test(readinessBlockMatch[0]), "readiness must not disable/hide the mic button");
  assert.ok(!/speakBtn\.(disabled|hidden)/.test(readinessBlockMatch[0]), "readiness must not disable/hide the speak button");
});

// 2026-08-27: readiness and system are now fetched together (Promise.all,
// each with its own .catch(() => null)), and the "unbekannt" fallback fires
// from the combined .then once it sees no usable readiness payload - not
// from a .catch attached directly to setReadyBadge as before. Both fetches
// degrading gracefully (rather than throwing) is still the property under
// test.
test("a failed readiness fetch is shown dezently and never throws or blocks the rest of the page", () => {
  const readinessBlockMatch = PAGE.match(/Jarvis-Readiness[\s\S]*?refreshJarvisReadiness\(\);/);
  assert.ok(readinessBlockMatch, "the readiness block must exist");
  const block = readinessBlockMatch[0];
  assert.ok(/fetch\("\/api\/jarvis\/ready"\)/.test(block), "the readiness fetch must be present");
  assert.ok(/\.catch\(function \(\) \{ return null; \}\)/.test(block), "a failed fetch must degrade to null, not throw");
  assert.ok(/setReadyBadge\("Jarvis-Status unbekannt", "pending"\);/.test(block), "no usable readiness payload must fall back to the unbekannt badge");
});

test("a transcribed recording fills the question field but never auto-submits", () => {
  assert.ok(/questionEl\.value\s*=/.test(PAGE), "the transcript must be written into the existing question field");
  const transcribeBlockMatch = PAGE.match(/stopRecordingAndTranscribe[\s\S]*?\n {2}\}/);
  assert.ok(transcribeBlockMatch, "the transcribe completion handler must exist");
  assert.ok(!/fetch\(\s*"\/api\/jarvis\/ask"/.test(transcribeBlockMatch[0]), "transcription must never itself call /api/jarvis/ask");
});

test("the mic button sends audio/wav, not JSON", () => {
  assert.ok(/"content-type":\s*"audio\/wav"/.test(PAGE));
});

// Voice v1, step 2: a manual "Vorlesen" button reads an already-displayed
// answer back out loud, locally. Never automatic.
test("the speak button sends JSON, never fires on its own, and only after an answer exists", () => {
  assert.ok(/speakBtn\.addEventListener\("click"/.test(PAGE), "Vorlesen must be a manual click handler");
  const speakBlockMatch = PAGE.match(/speakBtn\.addEventListener[\s\S]*?\n {2}\}\);/);
  assert.ok(speakBlockMatch, "the speak click handler must exist");
  assert.ok(/"content-type":\s*"application\/json"/.test(speakBlockMatch[0]), "speak must POST JSON, not audio");
  assert.ok(/currentAnswerText/.test(speakBlockMatch[0]), "speak must send the already-displayed answer text");
  assert.ok(!/setInterval|setTimeout/.test(speakBlockMatch[0]), "no automatic or looping playback trigger");
});

test("the speak row is hidden until an answer with text is rendered", () => {
  assert.ok(/id="speak-row"[^>]*hidden/.test(PAGE), "the speak row must start hidden");
  assert.ok(/speakRow\.hidden\s*=\s*!currentAnswerText/.test(PAGE), "the speak row is only shown once there is answer text");
});

test("audio playback never auto-plays outside the click handler", () => {
  assert.equal((PAGE.match(/new Audio\(/g) || []).length, 1, "exactly one Audio() construction, inside the click handler");
  assert.ok(!/autoplay/i.test(PAGE));
});

test("the page carries no token and no authorization header", () => {
  assert.ok(!/authorization/i.test(PAGE));
  assert.ok(!/AI_ROUTER_[A-Z_]*TOKEN\s*[:=]/.test(PAGE));
});

// The honest-rate-limit requirement: the page must name the limit and count
// down rather than leaving a click looking dead.
test("the page surfaces the rate limit explicitly with a countdown", () => {
  assert.ok(/COOLDOWN_SECONDS\s*=\s*5/.test(PAGE), "the 5s Jarvis-specific budget must be represented");
  assert.ok(PAGE.includes("Nächste Frage in"), "a countdown must be shown");
  assert.ok(PAGE.includes("eine Anfrage pro 5 Sekunden"), "the limit must be stated in plain words");
  assert.ok(/response\.status === 429/.test(PAGE), "a 429 must be handled as a limit, not as a generic error");
});

test("the page explains every warning the knowledge contract can emit", () => {
  for (const warning of [
    "no_context_no_knowledge", "index_stale", "index_age_warning", "index_incompatible",
    "index_error", "embedding_model_identity_unverified", "index_missing", "embedding_model_unavailable",
    "search_failed", "rate_limited", "concurrency_limited", "answer_provider_unavailable",
    "answer_model_unavailable", "model_response_invalid", "prompt_budget_exceeded",
    "model_source_validation_failed", "model_answer_too_large", "model_action_claim_blocked",
    "model_tool_call_output_blocked", "model_output_contains_path_or_url",
    "model_output_contains_command_reference", "internal_error"
  ]) {
    assert.ok(PAGE.includes(`${warning}:`), `warning ${warning} needs a plain-language explanation`);
  }
});

test("the page escapes rendered values instead of injecting raw HTML", () => {
  assert.ok(PAGE.includes("function escapeHtml"));
  assert.ok(/answerEl\.textContent\s*=/.test(PAGE), "the answer must be set as text, never as HTML");
});

// --- R1: Session/Context Manager (page side) ----------------------------

test("the page generates one session id per load via crypto.randomUUID, never persisted to localStorage", () => {
  assert.ok(/crypto\.randomUUID/.test(PAGE), "the page must use crypto.randomUUID (with a fallback) to mint a session id");
  assert.ok(/var jarvisSessionId\s*=\s*generateSessionId\(\)/.test(PAGE), "exactly one session id variable, assigned once at load");
  assert.ok(!/localStorage\.(setItem|getItem)/.test(PAGE), "a session id must never be persisted - a reload starts a new session on purpose");
});

test("every /api/jarvis/ask call sends the same jarvisSessionId, so voice and text share one session", () => {
  assert.equal((PAGE.match(/fetch\(\s*"\/api\/jarvis\/ask"/g) || []).length, 1, "there is exactly one call site to extend");
  assert.ok(/body:\s*JSON\.stringify\(\{\s*question:\s*question,\s*sessionId:\s*jarvisSessionId\s*\}\)/.test(PAGE),
    "the ask call must send both question and jarvisSessionId in the same body");
});

// --- M2: Sitzungszusammenfassung (Session Summary Layer, UI) ------------

test("the session id is exposed on window so the second script block can reuse it without a second identifier", () => {
  assert.ok(/window\.jarvisSessionId\s*=\s*jarvisSessionId/.test(PAGE), "jarvisSessionId must be shared via window, not duplicated");
});

test("the summary button is a manual click trigger, never fetched automatically on tab open or load", () => {
  assert.ok(/summaryBtn\.addEventListener\("click"/.test(PAGE), "the summary fetch must be a manual click handler");
  assert.equal((PAGE.match(/fetch\(\s*"\/api\/jarvis\/session\/summary"/g) || []).length, 1, "exactly one call site");
  const summaryBlockMatch = PAGE.match(/summaryBtn\.addEventListener[\s\S]*?\n {4}\}\);/);
  assert.ok(summaryBlockMatch, "the summary click handler must exist");
  assert.ok(!/setInterval|setTimeout/.test(summaryBlockMatch[0]), "no automatic polling of the summary route");
});

test("the summary request sends the shared jarvisSessionId, not a new or hardcoded id", () => {
  assert.ok(/body:\s*JSON\.stringify\(\{\s*sessionId:\s*window\.jarvisSessionId\s*\|\|\s*""\s*\}\)/.test(PAGE),
    "the summary POST body must send window.jarvisSessionId");
});

test("a null summary (no turns yet / unknown session) renders an honest empty state, not an error", () => {
  assert.ok(PAGE.includes("Für diese Sitzung liegt noch keine Zusammenfassung vor."));
});

test("the summary renders as text content, never innerHTML, matching the page's escaping discipline", () => {
  const renderSummaryMatch = PAGE.match(/function renderSummary[\s\S]*?\n  \}/);
  assert.ok(renderSummaryMatch, "renderSummary must exist");
  assert.ok(!/innerHTML/.test(renderSummaryMatch[0]), "summary turns must be rendered via textContent, not innerHTML");
});

test("the summary card explains it reads a different session view than the local Verlauf list", () => {
  assert.ok(PAGE.includes("unabhängig vom Verlauf oben"), "the summary card must distinguish itself from the client-side Verlauf list");
});
