import test from "node:test";
import assert from "node:assert/strict";
import { RunService } from "../orchestrator/run-service.js";
import { RouterError } from "../orchestrator/contracts.js";
import { buildResponse } from "../orchestrator/response-builder.js";

const cleanState = { repository: "C:\\repo", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" };

async function waitForTerminal(service, runId, maximumMs = 2_000) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    const run = service.get(runId);
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(run?.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Run did not reach a terminal state.");
}

test("a codex-cli process-start failure retries exactly once and then succeeds", async () => {
  let attempts = 0;
  const service = new RunService({
    adapters: { "codex-cli": { resolveExecutable: async () => "codex", run: () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new RouterError("CODEX_PROCESS_START_FAILED", "boom"));
      return Promise.resolve({ exitCode: 0, issues: [], stderr: "", events: [], resultSummary: "Analyse abgeschlossen." });
    } } },
    git: { captureGitState: async () => cleanState, compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {}, publish: async () => {}
  });
  const created = await service.create({ task: "Lies README.md", adapter: "codex-cli" });
  const finished = await waitForTerminal(service, created.runId);
  assert.equal(finished.status, "succeeded");
  assert.equal(attempts, 2);
  assert.equal(finished.retry.count, 1);
  assert.equal(finished.retry.lastReason, "process_start_failed");
});

test("a codex-cli process-start failure exhausts its single retry and fails with a stable error code", async () => {
  let attempts = 0;
  const service = new RunService({
    adapters: { "codex-cli": { resolveExecutable: async () => "codex", run: () => { attempts += 1; return Promise.reject(new RouterError("CODEX_PROCESS_START_FAILED", "boom")); } } },
    git: { captureGitState: async () => cleanState, compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {}, publish: async () => {}
  });
  const created = await service.create({ task: "Lies README.md", adapter: "codex-cli" });
  const finished = await waitForTerminal(service, created.runId);
  assert.equal(finished.status, "failed");
  assert.equal(attempts, 2);
  assert.equal(finished.retry.count, 1);
  assert.equal(finished.errorCode, "CODEX_PROCESS_START_FAILED");
  const response = buildResponse(finished);
  assert.equal(response.error.code, "CODEX_PROCESS_START_FAILED");
  assert.equal(JSON.stringify(response).includes("Lies README.md"), false);
});

test("a non-zero adapter exit code never retries and is reported as ADAPTER_FAILED", async () => {
  let attempts = 0;
  const service = new RunService({
    adapters: { "codex-cli": { resolveExecutable: async () => "codex", run: () => { attempts += 1; return Promise.resolve({ exitCode: 1, issues: [], stderr: "permission denied", events: [], resultSummary: null }); } } },
    git: { captureGitState: async () => cleanState, compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {}, publish: async () => {}
  });
  const created = await service.create({ task: "Lies README.md", adapter: "codex-cli" });
  const finished = await waitForTerminal(service, created.runId);
  assert.equal(finished.status, "failed");
  assert.equal(attempts, 1);
  assert.equal(finished.errorCode, "ADAPTER_FAILED");
});

test("a genuine timeout never retries the adapter", async () => {
  let attempts = 0;
  let resolveGitDelay;
  const gitDelay = new Promise((resolve) => { resolveGitDelay = resolve; });
  const service = new RunService({
    adapters: { "codex-cli": { resolveExecutable: async () => "codex", run: () => {
      attempts += 1;
      const operation = new Promise(() => {});
      operation.cancel = async () => ({ outcome: "signal_sent" });
      return operation;
    } } },
    git: { captureGitState: async () => { await gitDelay; return cleanState; }, compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {}, publish: async () => {}
  });
  const created = await service.create({ task: "Lies README.md", adapter: "codex-cli" });
  service.get(created.runId).timeoutMs = 20;
  resolveGitDelay();
  const finished = await waitForTerminal(service, created.runId, 5_000);
  assert.equal(finished.status, "timed_out");
  assert.equal(attempts, 1);
  assert.equal(finished.errorCode, "STEP_TIMEOUT");
});

test("cancelling a real codex-cli run performs the post-cancellation integrity check and does not retry", async () => {
  let attempts = 0;
  let gitCall = 0;
  let settleOperation;
  const service = new RunService({
    adapters: { "codex-cli": { resolveExecutable: async () => "codex", run: () => {
      attempts += 1;
      const operation = new Promise((resolve) => { settleOperation = resolve; });
      operation.cancel = async () => { settleOperation({ exitCode: null, signal: "SIGTERM", issues: [], stderr: "", events: [], resultSummary: null }); return { outcome: "signal_sent" }; };
      return operation;
    } } },
    git: { captureGitState: async () => (gitCall++ === 0 ? cleanState : cleanState), compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {}, publish: async () => {}
  });
  const created = await service.create({ task: "Lies README.md", adapter: "codex-cli" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await service.cancel(created.runId);
  const finished = await waitForTerminal(service, created.runId);
  assert.equal(finished.status, "cancelled");
  assert.equal(attempts, 1);
  assert.equal(finished.retry.count, 0);
  assert.equal(gitCall, 2);
});

test("cancelling a real codex-cli run that left a filesystem change is reported as READ_ONLY_VIOLATION_DETECTED", async () => {
  const dirtyState = { ...cleanState, status: "?? leftover-file" };
  let gitCall = 0;
  let settleOperation;
  const service = new RunService({
    adapters: { "codex-cli": { resolveExecutable: async () => "codex", run: () => {
      const operation = new Promise((resolve) => { settleOperation = resolve; });
      operation.cancel = async () => { settleOperation({ exitCode: null, signal: "SIGTERM", issues: [], stderr: "", events: [], resultSummary: null }); return { outcome: "signal_sent" }; };
      return operation;
    } } },
    git: { captureGitState: async () => (gitCall++ === 0 ? cleanState : dirtyState), compareGitState: (before, after) => ({ safe: before.status === after.status, changed: before.status === after.status ? [] : ["status"] }) },
    persist: async () => {}, publish: async () => {}
  });
  const created = await service.create({ task: "Lies README.md", adapter: "codex-cli" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await service.cancel(created.runId);
  const finished = await waitForTerminal(service, created.runId);
  assert.equal(finished.status, "failed");
  assert.equal(finished.errorCode, "READ_ONLY_VIOLATION_DETECTED");
});

test("an invalid working directory fails safely as WORKING_DIRECTORY_NOT_ALLOWED and never starts the adapter", async () => {
  let resolveCalls = 0;
  const service = new RunService({
    adapters: { "codex-cli": { resolveExecutable: async () => { resolveCalls += 1; return "codex"; }, run: async () => { throw new Error("must not run"); } } },
    git: { captureGitState: async () => { throw new RouterError("WORKING_DIRECTORY_NOT_ALLOWED", "Working directory is not allowed."); }, compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {}, publish: async () => {}
  });
  const created = await service.create({ task: "Lies README.md", adapter: "codex-cli", repository: "C:\\not-allowed" });
  const finished = await waitForTerminal(service, created.runId);
  assert.equal(finished.status, "failed");
  assert.equal(finished.errorCode, "WORKING_DIRECTORY_NOT_ALLOWED");
  assert.equal(resolveCalls, 0);
  const response = buildResponse(finished);
  assert.equal(response.error.code, "WORKING_DIRECTORY_NOT_ALLOWED");
});

test("a detected filesystem change after a normal run is reported as READ_ONLY_VIOLATION_DETECTED", async () => {
  const dirtyState = { ...cleanState, status: "?? unexpected-file" };
  let call = 0;
  const service = new RunService({
    adapters: { "codex-cli": { resolveExecutable: async () => "codex", run: async () => ({ exitCode: 0, issues: [], stderr: "", events: [], resultSummary: "Analyse abgeschlossen." }) } },
    git: { captureGitState: async () => (call++ === 0 ? cleanState : dirtyState), compareGitState: (before, after) => ({ safe: before.status === after.status, changed: before.status === after.status ? [] : ["status"] }) },
    persist: async () => {}, publish: async () => {}
  });
  const created = await service.create({ task: "Lies README.md", adapter: "codex-cli" });
  const finished = await waitForTerminal(service, created.runId);
  assert.equal(finished.status, "failed");
  assert.equal(finished.errorCode, "READ_ONLY_VIOLATION_DETECTED");
  assert.match(finished.errorSummary, /integrity check failed/i);
});

test("a succeeded run records a non-negative durationMs derived from started/finished timestamps", async () => {
  const service = new RunService({
    adapters: { "codex-cli": { resolveExecutable: async () => "codex", run: async () => ({ exitCode: 0, issues: [], stderr: "", events: [], resultSummary: "ok" }) } },
    git: { captureGitState: async () => cleanState, compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {}, publish: async () => {}
  });
  const created = await service.create({ task: "Lies README.md", adapter: "codex-cli" });
  const finished = await waitForTerminal(service, created.runId);
  assert.equal(finished.status, "succeeded");
  assert.ok(Number.isFinite(finished.durationMs));
  assert.ok(finished.durationMs >= 0);
});
