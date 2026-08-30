import test from "node:test";
import assert from "node:assert/strict";
import { RunService } from "../orchestrator/run-service.js";
import { CODEX_RUN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from "../orchestrator/config.js";

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

// Codex run timeout budget (2026-08-30): the real codex-cli adapter gets its
// own, longer timeout (CODEX_RUN_TIMEOUT_MS), separate from the value used
// for every mock/simulated workflow run (DEFAULT_TIMEOUT_MS unchanged there).
test("a real codex-cli run gets the dedicated CODEX_RUN_TIMEOUT_MS budget", async () => {
  const state = { repository: "C:\\repo", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" };
  const service = new RunService({
    adapter: { resolveCodexExecutable: async () => "codex", runCodex: () => { const op = new Promise(() => {}); op.cancel = () => {}; return op; } },
    git: { captureGitState: async () => state, compareGitState: () => ({ safe: true, changed: [] }) }, persist: async () => {}, publish: async () => {}
  });
  const run = await service.create({ task: "Prüf den AI-Router." });
  assert.equal(run.timeoutMs, CODEX_RUN_TIMEOUT_MS);
  assert.notEqual(CODEX_RUN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  await service.cancel(run.runId);
});

test("a mock (non-timeout-simulation) run still uses DEFAULT_TIMEOUT_MS, unaffected by the codex-only budget", async () => {
  const service = new RunService({ adapters: { mock: { run: () => { const op = new Promise(() => {}); op.cancel = () => {}; return op; } } }, persist: async () => {}, publish: async () => {} });
  const run = await service.create({ task: "Sortiere meine Einkaufsliste", adapter: "mock" });
  assert.equal(run.timeoutMs, DEFAULT_TIMEOUT_MS);
  await service.cancel(run.runId);
});

// Bug D (2026-08-30): a real codex-cli process can legitimately produce a
// complete result while ALSO tripping non-fatal stderr truncation (see
// codex-adapter.js's MAX_STDERR_LENGTH) - that alone must no longer turn a
// genuinely successful, complete analysis into a false "failed". Every other
// fatal condition (bad exit code, missing result, stderr_truncated combined
// with a real issue, any other issue) must keep failing exactly as before.
function codexResultState() { return { repository: "C:\\repo", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" }; }
function codexService(runCodex) {
  return new RunService({
    adapter: { resolveCodexExecutable: async () => "codex", runCodex },
    git: { captureGitState: async () => codexResultState(), compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {}, publish: async () => {}
  });
}
async function runToTerminal(service, task = "Prüf den AI-Router.") {
  const run = await service.create({ task });
  await new Promise((resolve) => setTimeout(resolve, 5));
  return service.get(run.runId);
}

test("1. exitCode=0 + full result + only stderr_truncated -> succeeded, warning kept", async () => {
  const service = codexService(async () => ({ exitCode: 0, issues: ["stderr_truncated"], stderr: "cut off", events: [], resultSummary: "Vollstaendige Analyse." }));
  const run = await runToTerminal(service);
  assert.equal(run.status, "succeeded");
  assert.equal(run.resultSummary, "Vollstaendige Analyse.");
  assert.ok(run.warnings.some((w) => w.includes("stderr")), "stderr_truncated must remain visible as a warning, not disappear");
});

test("2. exitCode=0 + no result + stderr_truncated -> failed", async () => {
  const service = codexService(async () => ({ exitCode: 0, issues: ["stderr_truncated"], stderr: "cut off", events: [], resultSummary: null }));
  const run = await runToTerminal(service);
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "ADAPTER_FAILED");
});

test("3. exitCode!=0 + result present + stderr_truncated -> failed", async () => {
  const service = codexService(async () => ({ exitCode: 1, issues: ["stderr_truncated"], stderr: "cut off", events: [], resultSummary: "Teilweise Analyse." }));
  const run = await runToTerminal(service);
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "ADAPTER_FAILED");
});

test("4. exitCode=0 + result + stderr_truncated + another issue -> failed", async () => {
  const service = codexService(async () => ({ exitCode: 0, issues: ["stderr_truncated", "some_other_issue"], stderr: "cut off", events: [], resultSummary: "Vollstaendige Analyse." }));
  const run = await runToTerminal(service);
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "ADAPTER_FAILED");
});

test("5. exitCode=0 + result + a single unrelated issue -> still failed (no general loosening)", async () => {
  const service = codexService(async () => ({ exitCode: 0, issues: ["some_other_issue"], stderr: "", events: [], resultSummary: "Vollstaendige Analyse." }));
  const run = await runToTerminal(service);
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "ADAPTER_FAILED");
});

test("no issues at all still succeeds and carries no stderr warning", async () => {
  const service = codexService(async () => ({ exitCode: 0, issues: [], stderr: "", events: [], resultSummary: "Vollstaendige Analyse." }));
  const run = await runToTerminal(service);
  assert.equal(run.status, "succeeded");
  assert.ok(!run.warnings.some((w) => w.includes("stderr")));
});

// Bug D extension (2026-08-30): jsonl_line_too_large is a confirmed second
// non-fatal issue - a real, complete "Prüf den AI-Router" run dropped one
// oversized intermediate JSONL line (a tool-output event, not the final
// answer) and still produced a full, correct resultSummary. Added to
// NON_FATAL_ADAPTER_ISSUES under the exact same strict guard as
// stderr_truncated - every other/unknown issue stays fatal.
test("1. exitCode=0 + full result + only jsonl_line_too_large -> succeeded", async () => {
  const service = codexService(async () => ({ exitCode: 0, issues: ["jsonl_line_too_large"], stderr: "", events: [], resultSummary: "Vollstaendige Analyse." }));
  const run = await runToTerminal(service);
  assert.equal(run.status, "succeeded");
  assert.equal(run.resultSummary, "Vollstaendige Analyse.");
});

test("2. exitCode=0 + full result + jsonl_line_too_large + stderr_truncated -> succeeded", async () => {
  const service = codexService(async () => ({ exitCode: 0, issues: ["jsonl_line_too_large", "stderr_truncated"], stderr: "cut off", events: [], resultSummary: "Vollstaendige Analyse." }));
  const run = await runToTerminal(service);
  assert.equal(run.status, "succeeded");
  assert.equal(run.resultSummary, "Vollstaendige Analyse.");
});

test("3. jsonl_line_too_large without a result -> failed", async () => {
  const service = codexService(async () => ({ exitCode: 0, issues: ["jsonl_line_too_large"], stderr: "", events: [], resultSummary: null }));
  const run = await runToTerminal(service);
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "ADAPTER_FAILED");
});

test("4. jsonl_line_too_large + another unknown issue -> failed", async () => {
  const service = codexService(async () => ({ exitCode: 0, issues: ["jsonl_line_too_large", "some_other_issue"], stderr: "", events: [], resultSummary: "Vollstaendige Analyse." }));
  const run = await runToTerminal(service);
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "ADAPTER_FAILED");
});
