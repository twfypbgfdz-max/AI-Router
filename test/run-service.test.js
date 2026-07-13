import test from "node:test";
import assert from "node:assert/strict";
import { RunService } from "../orchestrator/run-service.js";

test("Run service fails on non-zero exit code without writing through Codex", async () => { const state = { repository: "C:\\repo", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" }; const service = new RunService({ adapter: { resolveCodexExecutable: async () => "codex", runCodex: async () => ({ exitCode: 1, issues: [], stderr: "failure", events: [], resultSummary: null }) }, git: { captureGitState: async () => state, compareGitState: () => ({ safe: true, changed: [] }) }, persist: async () => {}, publish: async () => {} }); const run = await service.create({ task: "Read only." }); await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(service.get(run.runId).status, "failed"); });

test("Run service permits only one active run", async () => {
  const state = { repository: "C:\\repo", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" };
  let finish;
  const operation = new Promise((resolve) => { finish = resolve; });
  operation.cancel = () => {};
  const service = new RunService({ adapter: { resolveCodexExecutable: async () => "codex", runCodex: () => operation }, git: { captureGitState: async () => state, compareGitState: () => ({ safe: true, changed: [] }) }, persist: async () => {}, publish: async () => {} });
  const first = await service.create({ task: "First." });
  await assert.rejects(service.create({ task: "Second." }), /already active/);
  finish({ exitCode: 0, issues: [], stderr: "", events: [{ text: "ok" }], resultSummary: "ok" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(service.get(first.runId).status, "succeeded");
});

test("initial persistence failure releases the active run lock", async () => {
  let writes = 0;
  const service = new RunService({ persist: async () => { writes += 1; if (writes === 1) throw new Error("disk failed"); }, publish: async () => {} });
  await assert.rejects(service.create({ task: "First." }), /disk failed/);
  assert.equal(service.activeRunId, null);
  service.execute = async () => {};
  const next = await service.create({ task: "Second." });
  assert.ok(next.runId);
});

test("Run service accepts only its explicit adapter registry", async () => {
  const service = new RunService({ adapters: { mock: { run: async () => ({}) } }, persist: async () => {}, publish: async () => {} });
  await assert.rejects(service.create({ task: "No.", adapter: "shell" }), /Unsupported adapter/);
  await assert.rejects(service.create({ task: "No.", adapter: "mock", simulationMode: "command" }), /Unsupported simulation mode/);
});

test("Reviewer failure mode requires a server-selected reviewer workflow", async () => {
  const service = new RunService({ adapters: { mock: { run: async () => ({}) } }, persist: async () => {}, publish: async () => {} });
  await assert.rejects(service.create({ task: "Sortiere meine Einkaufsliste", adapter: "mock", simulationMode: "failure_reviewer" }), /requires a reviewer workflow/);
});

test("Mock timeout uses the fixed short test timeout", async () => {
  const state = { repository: "C:\\repo", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" };
  let received;
  const service = new RunService({
    adapters: { mock: { run: (options) => { received = options; return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); } } },
    git: { captureGitState: async () => state, compareGitState: () => ({ safe: true, changed: [] }) }, persist: async () => {}, publish: async () => {}
  });
  const run = await service.create({ task: "Timeout.", adapter: "mock", simulationMode: "timeout" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(run.timeoutMs, 3_000);
  assert.equal(received.simulationMode, "timeout");
  await service.cancel(run.runId);
});
