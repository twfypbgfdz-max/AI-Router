import test from "node:test";
import assert from "node:assert/strict";
import { buildJarvisRunResult } from "../orchestrator/jarvis/run-dispatcher.js";

function baseRun(overrides = {}) {
  return {
    runId: "run_123_abcd",
    status: "succeeded",
    sessionId: "sess-1",
    project: "ai-router",
    resultSummary: "Alles geprueft, keine Aenderung.",
    errorCode: null,
    warnings: [],
    ...overrides
  };
}

// 6. a successful run becomes a safe, Jarvis-consumable result structure.
test("6. a succeeded run yields a safe Jarvis result with the real summary", () => {
  const result = buildJarvisRunResult(baseRun());
  assert.equal(result.runId, "run_123_abcd");
  assert.equal(result.status, "succeeded");
  assert.equal(result.sessionId, "sess-1");
  assert.deepEqual(result.project, { id: "ai-router", name: "AI-Router" });
  assert.equal(result.resultAvailable, true);
  assert.equal(result.summary, "Alles geprueft, keine Aenderung.");
  assert.equal(result.errorCode, null);
});

// 7. a failed run never claims a false success.
test("7. a failed run never reports resultAvailable=true or a summary", () => {
  const result = buildJarvisRunResult(baseRun({ status: "failed", resultSummary: null, errorCode: "ADAPTER_FAILED" }));
  assert.equal(result.status, "failed");
  assert.equal(result.resultAvailable, false);
  assert.equal(result.summary, null);
  assert.equal(result.errorCode, "ADAPTER_FAILED");
});

// 8. a still-running run reports resultAvailable=false, not a guess.
test("8. a running run reports resultAvailable=false even if resultSummary is somehow already set", () => {
  const result = buildJarvisRunResult(baseRun({ status: "running", resultSummary: "not final yet" }));
  assert.equal(result.status, "running");
  assert.equal(result.resultAvailable, false);
  assert.equal(result.summary, null);
});

// 9. sessionId is carried through unchanged, and stays null when absent.
test("9. sessionId passes through unchanged", () => {
  assert.equal(buildJarvisRunResult(baseRun({ sessionId: "sess-42" })).sessionId, "sess-42");
  assert.equal(buildJarvisRunResult(baseRun({ sessionId: null })).sessionId, null);
  assert.equal(buildJarvisRunResult(baseRun({ sessionId: undefined })).sessionId, null);
});

// 10. an unknown/missing project on the run never hallucinates a path or a
// fabricated name - it degrades to null rather than guessing.
test("10. a run with no matching known project yields project: null, no path anywhere", () => {
  const result = buildJarvisRunResult(baseRun({ project: "some-unregistered-id" }));
  assert.equal(result.project, null);
  assert.ok(!/[A-Za-z]:\\/.test(JSON.stringify(result)));
});

test("10b. a run with no project field at all also yields project: null", () => {
  const result = buildJarvisRunResult(baseRun({ project: undefined }));
  assert.equal(result.project, null);
});

test("null/invalid run input returns null, never throws", () => {
  assert.equal(buildJarvisRunResult(null), null);
  assert.equal(buildJarvisRunResult(undefined), null);
  assert.equal(buildJarvisRunResult("not a run"), null);
});

test("an invalid/unknown status is projected as failed, not passed through raw", () => {
  const result = buildJarvisRunResult(baseRun({ status: "not_a_real_status" }));
  assert.equal(result.status, "failed");
  assert.equal(result.resultAvailable, false);
});

test("warnings are bounded, sanitized and capped, and no local path can leak through them", () => {
  const result = buildJarvisRunResult(baseRun({ warnings: ["Adapter-Ausgabe (stderr) wurde beim Sammeln gekuerzt; das Endergebnis war dennoch vollstaendig.", "C:\\Users\\felil\\secret\\path leaked"] }));
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings[0].includes("stderr"));
  // 2026-08-30 real codex-cli smoke test finding: this assertion was missing
  // before - the test's own name already promised "no local path can leak"
  // but only ever checked warnings[0], never the second (deliberately
  // path-carrying) warning. A real run then leaked exactly this shape.
  assert.ok(!result.warnings[1].includes("C:\\"), "the second warning must not carry the raw local path either");
  assert.ok(!/[A-Za-z]:[\\/]/.test(JSON.stringify(result.warnings)), "no absolute local path in any warning");
});

// 2026-08-30 J1.3 hardening, real codex-cli finding: a real analysis result
// can freely quote absolute local paths (e.g. in a markdown-style file
// reference). sanitizeText() (jsonl.js) only strips secrets/tokens and
// bounds length - it was never meant to catch path shapes. redactLocalPaths()
// in run-dispatcher.js is the targeted fix, applied only to this outgoing
// projection (see the next block of tests for why the internal run keeps
// its original text).
test("1. a Windows backslash path in the summary is redacted", () => {
  const result = buildJarvisRunResult(baseRun({ resultSummary: "Siehe C:\\Users\\felil\\Documents\\KI\\AI-Router\\orchestrator\\run-service.js fuer Details." }));
  assert.ok(!result.summary.includes("C:\\"), "no raw backslash path may survive");
  assert.ok(result.summary.includes("[local-path]"));
});

test("2. a Windows forward-slash path in the summary is redacted (the exact markdown-link shape codex produced)", () => {
  const result = buildJarvisRunResult(baseRun({ resultSummary: "Siehe [run-dispatcher.js](C:/Users/felil/Documents/KI/AI-Router/orchestrator/jarvis/run-dispatcher.js:169) fuer Details." }));
  assert.ok(!/[A-Za-z]:\//.test(result.summary), "no raw forward-slash path may survive");
  assert.ok(result.summary.includes("[local-path]"));
});

test("3. multiple paths (backslash, forward-slash, another drive letter) are all redacted", () => {
  const result = buildJarvisRunResult(baseRun({
    resultSummary: "A: C:\\Users\\felil\\a.js  B: C:/Users/felil/b.js  C: D:\\Backup\\c.txt"
  }));
  assert.ok(!/[A-Za-z]:[\\/]/.test(result.summary), "no absolute local path of any drive letter may survive");
  assert.equal((result.summary.match(/\[local-path\]/g) || []).length, 3, "all three paths must be individually redacted");
});

test("4. ordinary text with a colon but no path is left completely unchanged", () => {
  const text = "Das Verhaeltnis ist 3:2, die Uhrzeit 12:30. Governance: approvalRequired=false, riskLevel=R0.";
  const result = buildJarvisRunResult(baseRun({ resultSummary: text }));
  assert.equal(result.summary, text, "text without a drive-letter path must pass through byte-for-byte");
});

test("5. redaction is scoped to the outgoing Jarvis projection only - the internal run object keeps its original, unredacted resultSummary", () => {
  const run = baseRun({ resultSummary: "Siehe C:\\Users\\felil\\Documents\\KI\\AI-Router\\orchestrator\\run-service.js." });
  buildJarvisRunResult(run);
  assert.ok(run.resultSummary.includes("C:\\Users\\felil"), "buildJarvisRunResult must not mutate the run it was given - internal consumers still need the real path");
});

// 2026-08-30, second real codex-cli smoke test finding: codex-cli itself
// referenced the very file being reviewed using MSYS/Git-Bash drive-mount
// notation ("/c/Users/felil/...") rather than the classic Windows form the
// tests above already cover - same local path, different spelling, and it
// survived the first redaction pass unredacted.
test("MSYS-1. a /c/Users/... Git-Bash-style path in the summary is redacted", () => {
  const result = buildJarvisRunResult(baseRun({ resultSummary: "Siehe [x](</c/Users/felil/Documents/KI/AI-Router/orchestrator/jarvis/run-dispatcher.js:164>) fuer Details." }));
  assert.ok(!/\/[a-z]\/Users\//.test(result.summary), "no raw /c/Users/... path may survive");
  assert.ok(result.summary.includes("[local-path]"));
});

test("MSYS-2. a /d/Projects/... path on a different drive letter is redacted", () => {
  const result = buildJarvisRunResult(baseRun({ resultSummary: "Datei liegt unter /d/Projects/foo/bar.js" }));
  assert.ok(result.summary.includes("[local-path]"));
  assert.ok(!result.summary.includes("/d/Projects"));
});

test("MSYS-3. a path surrounded by whitespace is redacted in full, surrounding text untouched", () => {
  const result = buildJarvisRunResult(baseRun({ resultSummary: "Text davor.  /c/Users/felil/Documents/KI/AI-Router  Text danach." }));
  // sanitizeText() already collapses repeated whitespace before redaction
  // runs - unrelated pre-existing behaviour, not something this fix changes.
  assert.equal(result.summary, "Text davor. [local-path] Text danach.");
});

test("MSYS-4. mixed Windows-drive and MSYS-mount paths in one summary are all redacted", () => {
  const result = buildJarvisRunResult(baseRun({
    resultSummary: "A: C:\\Users\\felil\\a.js  B: /c/Users/felil/b.js  C: D:\\Backup\\c.txt  D: /d/Projects/x.txt"
  }));
  assert.ok(!/[A-Za-z]:[\\/]/.test(result.summary), "no classic Windows path may survive");
  assert.ok(!/\/[a-z]\/[A-Za-z]/.test(result.summary), "no MSYS-mount path may survive");
  assert.equal((result.summary.match(/\[local-path\]/g) || []).length, 4, "all four paths must be individually redacted");
});

test("MSYS-5. an ordinary /api/... route reference is left completely unchanged (no general Unix-path masking)", () => {
  const text = "Aufruf ueber /api/jarvis/run/run_1788121760854_6d8c8693 war erfolgreich.";
  const result = buildJarvisRunResult(baseRun({ resultSummary: text }));
  assert.equal(result.summary, text, "a multi-letter first segment (api) must never be mistaken for a single-letter drive mount");
});

test("MSYS-6. an ordinary relative repo path is left completely unchanged", () => {
  const text = "Siehe orchestrator/server.js und test/jarvis-run-route.test.js.";
  const result = buildJarvisRunResult(baseRun({ resultSummary: text }));
  assert.equal(result.summary, text, "a relative path with no leading slash must never be redacted");
});

test("MSYS-7. ordinary multi-letter Unix paths (/usr, /home) are never redacted - no general Unix-path masking", () => {
  const text = "Konfiguration liegt unter /usr/lib/foo und /home/felil/.bashrc.";
  const result = buildJarvisRunResult(baseRun({ resultSummary: text }));
  assert.equal(result.summary, text, "multi-letter first segments must never be mistaken for a single-letter drive mount");
});

test("no raw resultSummary/task text leaks beyond the sanitized summary field", () => {
  const result = buildJarvisRunResult(baseRun());
  const keys = Object.keys(result);
  assert.ok(!keys.includes("task"));
  assert.ok(!keys.includes("repository"));
  assert.ok(!keys.includes("events"));
});
