import test from "node:test";
import assert from "node:assert/strict";
import { buildAdapterInput, buildAdapterOutput } from "../orchestrator/adapter-contract.js";

const validInput = { adapter: "codex-cli", requestId: "req_1", runId: "run_1", taskType: "read_only_codex", safeInstruction: "Nur lesen.", workingDirectory: "C:\\repo", timeoutMs: 120_000, maxOutputBytes: 65_536, retryAttempt: 0 };

test("buildAdapterInput accepts a complete, valid contract input", () => {
  const input = buildAdapterInput(validInput);
  assert.equal(input.adapter, "codex-cli");
  assert.equal(input.workingDirectory, "C:\\repo");
  assert.equal(input.retryAttempt, 0);
  assert.equal(input.abortSignal, null);
});

test("buildAdapterInput rejects missing or invalid required fields", () => {
  for (const field of ["adapter", "requestId", "runId", "workingDirectory", "safeInstruction"]) {
    assert.throws(() => buildAdapterInput({ ...validInput, [field]: "" }));
  }
  assert.throws(() => buildAdapterInput({ ...validInput, taskType: "deploy" }));
  assert.throws(() => buildAdapterInput({ ...validInput, timeoutMs: 0 }));
  assert.throws(() => buildAdapterInput({ ...validInput, maxOutputBytes: -1 }));
  assert.throws(() => buildAdapterInput({ ...validInput, retryAttempt: -1 }));
  assert.throws(() => buildAdapterInput({ ...validInput, retryAttempt: 1.5 }));
});

test("buildAdapterOutput computes durationMs and normalizes optional fields", () => {
  const output = buildAdapterOutput({ adapter: "codex-cli", status: "succeeded", success: true, exitCode: 0, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:02.500Z", result: { summary: "ok" } });
  assert.equal(output.durationMs, 2_500);
  assert.equal(output.success, true);
  assert.deepEqual(output.result, { summary: "ok" });
  assert.deepEqual(output.warnings, []);
  assert.deepEqual(output.safeMetadata, {});
  assert.equal(output.error, null);
});

test("buildAdapterOutput rejects an unknown status and leaves durationMs null without timestamps", () => {
  assert.throws(() => buildAdapterOutput({ adapter: "codex-cli", status: "exploded" }));
  const output = buildAdapterOutput({ adapter: "codex-cli", status: "failed", success: false });
  assert.equal(output.durationMs, null);
});

test("adapter contract objects are frozen against later mutation", () => {
  const input = buildAdapterInput(validInput);
  assert.throws(() => { input.adapter = "other"; }, TypeError);
  const output = buildAdapterOutput({ adapter: "codex-cli", status: "succeeded", success: true, warnings: ["a"] });
  assert.throws(() => { output.warnings.push("b"); }, TypeError);
});
