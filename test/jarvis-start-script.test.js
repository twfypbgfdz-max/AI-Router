import test from "node:test";
import assert from "node:assert/strict";
import { describeReason, formatReadinessReport, runJarvisStart } from "../scripts/jarvis-start.js";

function readiness(overrides = {}) {
  return Object.freeze({ state: "ready", coreReady: true, voiceReady: true, reasons: [], ...overrides });
}

// --- describeReason / formatReadinessReport: presentation only ----------

test("every reason code jarvis-readiness.js can actually produce has German text", () => {
  const allReasonCodes = [
    "answer_provider_unavailable", "answer_model_unavailable", "embedding_model_unavailable",
    "index_missing", "index_stale", "index_incompatible", "index_error",
    "WHISPER_NOT_CONFIGURED", "PIPER_NOT_CONFIGURED", "PIPER_UNAVAILABLE"
  ];
  for (const code of allReasonCodes) {
    const text = describeReason(code);
    assert.notEqual(text, code, `${code} has no German text mapped`);
    assert.match(text, /[a-zA-ZäöüÄÖÜß]/);
  }
});

// Defense-in-depth: an unrecognised code must still be visible, not hidden.
test("an unknown reason code falls back to itself rather than disappearing", () => {
  assert.equal(describeReason("some_future_code_not_yet_mapped"), "some_future_code_not_yet_mapped");
});

test("a ready report names Core as ready, no reasons listed, and shows both Voice engines when a voice status is supplied", () => {
  const report = formatReadinessReport(readiness(), { whisper: "active", piper: "ready" });
  assert.match(report, /Jarvis core ready/);
  assert.match(report, /Voice:/);
  assert.match(report, /Piper TTS: bereit/);
  assert.match(report, /Whisper STT: aktiv/);
});

test("without a voice status, the report omits the Voice: block entirely rather than guessing", () => {
  const report = formatReadinessReport(readiness());
  assert.match(report, /Jarvis core ready/);
  assert.ok(!/Voice:/.test(report));
});

test("a partial report is headed 'Jarvis partial:' and lists every reason", () => {
  const report = formatReadinessReport(readiness({ state: "partial", coreReady: true, voiceReady: false, reasons: ["WHISPER_NOT_CONFIGURED", "PIPER_NOT_CONFIGURED"] }));
  assert.match(report, /^Jarvis partial:/);
  assert.match(report, /Spracheingabe \(Whisper\) ist nicht konfiguriert\./);
  assert.match(report, /Sprachausgabe \(Piper\) ist nicht konfiguriert\./);
});

// The honest-status case this whole change exists for: Whisper's URL is set
// but the process isn't reachable - the report must say "konfiguriert", not
// silently imply readiness the way the old flat "Voice: bereit." once did.
test("Whisper configured but unreachable shows as 'konfiguriert', not as ready", () => {
  const report = formatReadinessReport(readiness({ state: "partial", coreReady: true, voiceReady: false }), { whisper: "configured", piper: "ready" });
  assert.match(report, /Whisper STT: konfiguriert/);
  assert.ok(!/Whisper STT: aktiv/.test(report));
});

// The required case: index_stale must read as "still usable, last-known-good",
// not as an outright failure - it only ever appears inside a "partial" report.
test("an index_stale partial report reads as usable-with-a-caveat, not as a failure", () => {
  const report = formatReadinessReport(readiness({ state: "partial", coreReady: true, voiceReady: true, reasons: ["index_stale"] }));
  assert.match(report, /^Jarvis partial:/);
  assert.match(report, /letzte bekannte Stand wird weiter verwendet/);
});

test("an unavailable report is headed 'Jarvis unavailable:' and lists every reason", () => {
  const report = formatReadinessReport(readiness({ state: "unavailable", coreReady: false, reasons: ["answer_provider_unavailable"] }));
  assert.match(report, /^Jarvis unavailable:/);
  assert.match(report, /Ollama ist nicht erreichbar\./);
});

test("the report never contains a filesystem path or a URL", () => {
  for (const state of ["ready", "partial", "unavailable"]) {
    const report = formatReadinessReport(readiness({
      state, coreReady: state !== "unavailable", voiceReady: state === "ready",
      reasons: state === "ready" ? [] : ["answer_provider_unavailable", "WHISPER_NOT_CONFIGURED", "PIPER_UNAVAILABLE"]
    }), { whisper: "configured", piper: "unavailable" });
    assert.ok(!/[A-Za-z]:\\/.test(report));
    assert.ok(!/https?:\/\//.test(report));
  }
});

// --- runJarvisStart: the gating decision, per state ----------------------

function collector() {
  const logs = [];
  const errors = [];
  const started = [];
  return {
    log: (message) => logs.push(message),
    errorLog: (message) => errors.push(message),
    startServerFn: () => { started.push(true); },
    // Fixed fake by default so these gating tests never touch the real
    // network/env - only the dedicated Voice-status tests below override it.
    checkVoiceStatusFn: async () => Object.freeze({ whisper: "unavailable", piper: "unavailable" }),
    logs, errors, started
  };
}

test("ready: the server is started, nothing is written to exitCode, report goes to stdout", async () => {
  const c = collector();
  process.exitCode = undefined;
  const result = await runJarvisStart({ checkReadinessFn: async () => readiness(), checkVoiceStatusFn: c.checkVoiceStatusFn, startServerFn: c.startServerFn, log: c.log, errorLog: c.errorLog });
  assert.equal(result.started, true);
  assert.equal(c.started.length, 1);
  assert.equal(c.errors.length, 0);
  assert.equal(process.exitCode, undefined);
  assert.match(c.logs[0], /Jarvis core ready/);
});

test("partial (Voice missing): the server is still started, Core stays usable", async () => {
  const c = collector();
  process.exitCode = undefined;
  const result = await runJarvisStart({
    checkReadinessFn: async () => readiness({ state: "partial", coreReady: true, voiceReady: false, reasons: ["PIPER_NOT_CONFIGURED"] }),
    checkVoiceStatusFn: c.checkVoiceStatusFn, startServerFn: c.startServerFn, log: c.log, errorLog: c.errorLog
  });
  assert.equal(result.started, true);
  assert.equal(c.started.length, 1);
  assert.equal(process.exitCode, undefined);
  assert.match(c.logs[0], /^Jarvis partial:/);
});

// The required case: index_stale (last-known-good, still usable) must start
// the server exactly like any other "partial" - never treated as a failure.
test("partial (index_stale, last-known-good): the server is still started", async () => {
  const c = collector();
  process.exitCode = undefined;
  const result = await runJarvisStart({
    checkReadinessFn: async () => readiness({ state: "partial", coreReady: true, voiceReady: true, reasons: ["index_stale"] }),
    checkVoiceStatusFn: c.checkVoiceStatusFn, startServerFn: c.startServerFn, log: c.log, errorLog: c.errorLog
  });
  assert.equal(result.started, true);
  assert.equal(c.started.length, 1);
  assert.equal(process.exitCode, undefined);
});

// F2 (Felix Core Foundation v2): the router process must start regardless
// of readiness state, so /api/health and /api/jarvis/ready are reachable
// even while Ollama is not yet up (e.g. a slow-boot race at Windows login)
// - a request-level degradation (jarvis-readiness.js) replaces what used to
// be a process-level refusal to start.
test("unavailable: the server IS started (graceful degradation), report still goes to stdout, no exitCode set", async () => {
  const c = collector();
  process.exitCode = undefined;
  const result = await runJarvisStart({
    checkReadinessFn: async () => readiness({ state: "unavailable", coreReady: false, voiceReady: false, reasons: ["answer_provider_unavailable"] }),
    checkVoiceStatusFn: c.checkVoiceStatusFn, startServerFn: c.startServerFn, log: c.log, errorLog: c.errorLog
  });
  assert.equal(result.started, true);
  assert.equal(c.started.length, 1, "the router must start even when Core is unavailable at boot - readiness degrades per-request, not the process");
  assert.equal(process.exitCode, undefined);
  assert.equal(c.errors.length, 0);
  assert.match(c.logs[0], /^Jarvis unavailable:/);
});

test("runJarvisStart calls checkJarvisReadiness exactly once - no duplicated readiness logic, no second check", async () => {
  const c = collector();
  process.exitCode = undefined;
  let calls = 0;
  await runJarvisStart({
    checkReadinessFn: async () => { calls += 1; return readiness(); },
    checkVoiceStatusFn: c.checkVoiceStatusFn, startServerFn: c.startServerFn, log: c.log, errorLog: c.errorLog
  });
  assert.equal(calls, 1);
});

// Whisper/Piper state must never affect whether the router starts - only
// what the printed report says. The gate stays exclusively on
// checkReadinessFn's Core verdict.
test("Voice status never affects the start/no-start gate, even when Core is 'ready'", async () => {
  const c = collector();
  process.exitCode = undefined;
  const result = await runJarvisStart({
    checkReadinessFn: async () => readiness(),
    checkVoiceStatusFn: async () => Object.freeze({ whisper: "unavailable", piper: "unavailable" }),
    startServerFn: c.startServerFn, log: c.log, errorLog: c.errorLog
  });
  assert.equal(result.started, true);
  assert.match(c.logs[0], /Whisper STT: nicht verfügbar/);
});

test("runJarvisStart's printed report reflects the real Whisper/Piper status, not a guess", async () => {
  const c = collector();
  process.exitCode = undefined;
  await runJarvisStart({
    checkReadinessFn: async () => readiness(),
    checkVoiceStatusFn: async () => Object.freeze({ whisper: "active", piper: "ready" }),
    startServerFn: c.startServerFn, log: c.log, errorLog: c.errorLog
  });
  assert.match(c.logs[0], /Whisper STT: aktiv/);
  assert.match(c.logs[0], /Piper TTS: bereit/);
});
