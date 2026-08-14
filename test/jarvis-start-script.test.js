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

test("a ready report names Core and Voice as ready, no reasons listed", () => {
  const report = formatReadinessReport(readiness());
  assert.match(report, /Jarvis core ready/);
  assert.match(report, /Voice/i);
});

test("a partial report is headed 'Jarvis partial:' and lists every reason", () => {
  const report = formatReadinessReport(readiness({ state: "partial", coreReady: true, voiceReady: false, reasons: ["WHISPER_NOT_CONFIGURED", "PIPER_NOT_CONFIGURED"] }));
  assert.match(report, /^Jarvis partial:/);
  assert.match(report, /Spracheingabe \(Whisper\) ist nicht konfiguriert\./);
  assert.match(report, /Sprachausgabe \(Piper\) ist nicht konfiguriert\./);
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
    }));
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
    logs, errors, started
  };
}

test("ready: the server is started, nothing is written to exitCode, report goes to stdout", async () => {
  const c = collector();
  process.exitCode = undefined;
  const result = await runJarvisStart({ checkReadinessFn: async () => readiness(), startServerFn: c.startServerFn, log: c.log, errorLog: c.errorLog });
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
    startServerFn: c.startServerFn, log: c.log, errorLog: c.errorLog
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
    startServerFn: c.startServerFn, log: c.log, errorLog: c.errorLog
  });
  assert.equal(result.started, true);
  assert.equal(c.started.length, 1);
  assert.equal(process.exitCode, undefined);
});

test("unavailable: the server is NOT started, exitCode is set to 1, report goes to stderr", async () => {
  const c = collector();
  process.exitCode = undefined;
  const result = await runJarvisStart({
    checkReadinessFn: async () => readiness({ state: "unavailable", coreReady: false, voiceReady: false, reasons: ["answer_provider_unavailable"] }),
    startServerFn: c.startServerFn, log: c.log, errorLog: c.errorLog
  });
  assert.equal(result.started, false);
  assert.equal(c.started.length, 0, "the router must never be started when Core is unavailable");
  assert.equal(process.exitCode, 1);
  assert.equal(c.logs.length, 0);
  assert.match(c.errors[0], /^Jarvis unavailable:/);
  process.exitCode = undefined;
});

test("runJarvisStart calls checkJarvisReadiness exactly once - no duplicated readiness logic, no second check", async () => {
  const c = collector();
  process.exitCode = undefined;
  let calls = 0;
  await runJarvisStart({
    checkReadinessFn: async () => { calls += 1; return readiness(); },
    startServerFn: c.startServerFn, log: c.log, errorLog: c.errorLog
  });
  assert.equal(calls, 1);
});
