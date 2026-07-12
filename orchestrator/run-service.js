import crypto from "node:crypto";
import { DEFAULT_TIMEOUT_MS, MAX_RESULT_LENGTH, MAX_TASK_LENGTH, MOCK_TIMEOUT_MS, PROCESS_SETTLE_TIMEOUT_MS, REPOSITORY_ROOT } from "./config.js";
import { captureGitState, compareGitState } from "./git-safety.js";
import { resolveCodexExecutable, runCodex } from "./codex-adapter.js";
import { saveRun } from "./run-store.js";
import { saveCockpitStatus } from "./cockpit-status.js";
import { reduceEvents, sanitizeText } from "./jsonl.js";
import { isMockSimulationMode, runMock } from "./mock-adapter.js";
import { createRoutePlan } from "./routing-engine.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "awaiting_approval"]);
const ADAPTER_NAMES = new Set(["mock", "codex-cli"]);

function defaultAdapters() {
  return {
    mock: { run: runMock },
    "codex-cli": { resolveExecutable: resolveCodexExecutable, run: ({ repository, task, executable }) => runCodex({ repository, prompt: task, executable }) }
  };
}

export class RunService {
  constructor({ adapters, adapter, git = { captureGitState, compareGitState }, persist = saveRun, publish = saveCockpitStatus } = {}) {
    this.adapters = adapters || (adapter ? { "codex-cli": { resolveExecutable: adapter.resolveCodexExecutable, run: ({ repository, task, executable }) => adapter.runCodex({ repository, prompt: task, executable }) } } : defaultAdapters());
    this.defaultAdapter = adapter ? "codex-cli" : "mock";
    this.git = git; this.persist = persist; this.publish = publish; this.runs = new Map(); this.operations = new Map(); this.activeRunId = null;
  }
  async update(run, status, fields = {}) {
    if (TERMINAL.has(run.status) && run.status !== status) throw new Error("Terminal run state cannot change.");
    run.status = status; Object.assign(run, fields, { updatedAt: new Date().toISOString() });
    await this.persist(run); await this.publish(run); return run;
  }
  async create({ task, repository = REPOSITORY_ROOT, adapter, simulationMode } = {}) {
    if (typeof task !== "string" || !task.trim() || task.length > MAX_TASK_LENGTH) throw new Error("Task must be a non-empty bounded string.");
    const routePlan = createRoutePlan(task);
    let adapterName = adapter || this.defaultAdapter;
    if (!ADAPTER_NAMES.has(adapterName) || !this.adapters[adapterName]) throw new Error("Unsupported adapter.");
    if (adapterName === "mock" && simulationMode !== undefined && !isMockSimulationMode(simulationMode)) throw new Error("Unsupported simulation mode.");
    if (adapterName !== "mock" && simulationMode !== undefined) throw new Error("Simulation mode is only available for the mock adapter.");
    if (routePlan.approvalRequired && adapterName !== "mock") {
      adapterName = "mock";
      routePlan.warnings.push("Der angeforderte Adapter wurde wegen des Freigabe-Gates durch eine reine Simulation ersetzt.");
    }
    routePlan.executionAdapter = adapterName;
    if (this.activeRunId) throw new Error("A router run is already active.");
    const mode = adapterName === "mock" ? (simulationMode || "success") : null;
    const timeoutMs = adapterName === "mock" && mode === "timeout" ? MOCK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const run = { runId: `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), task: task.trim(), repository, branchBefore: null, branchAfter: null, gitStatusBefore: null, gitStatusAfter: null, adapter: adapterName, simulationMode: mode, executable: null, mode: "read-only", status: "created", startedAt: null, finishedAt: null, timeoutMs, exitCode: null, resultSummary: null, errorSummary: null, usage: null, events: [], warnings: [...routePlan.warnings], routePlan };
    this.activeRunId = run.runId;
    this.runs.set(run.runId, run);
    try { await this.persist(run); await this.publish(run); }
    catch (error) {
      this.runs.delete(run.runId);
      if (this.activeRunId === run.runId) this.activeRunId = null;
      throw error;
    }
    this.execute(run).finally(() => { if (this.activeRunId === run.runId) this.activeRunId = null; });
    return run;
  }
  async execute(run) {
    await this.update(run, "validating");
    try {
      const before = await this.git.captureGitState(run.repository);
      run.repository = before.repository; run.branchBefore = before.branch; run.gitStatusBefore = before.status; run.gitBefore = before;
      if (run.cancelRequested) return this.update(run, "cancelled", { branchAfter: before.branch, gitStatusAfter: before.status, finishedAt: new Date().toISOString(), errorSummary: "Cancelled by user." });
      if (run.routePlan?.approvalRequired) return this.update(run, "awaiting_approval", { branchAfter: before.branch, gitStatusAfter: before.status, finishedAt: new Date().toISOString(), resultSummary: "Freigabe erforderlich. Der Route-Plan wurde gespeichert; die erkannte Aktion wurde nicht ausgeführt." });
      if (/^(main|master|production)$|^release\//.test(before.branch)) run.warnings.push("Read-only analysis is running on a production-named branch.");
      const adapter = this.adapters[run.adapter];
      if (adapter.resolveExecutable) run.executable = await adapter.resolveExecutable();
      await this.update(run, "queued");
      return this.start(run);
    } catch (error) { return this.update(run, "failed", { finishedAt: new Date().toISOString(), errorSummary: sanitizeText(error.message, 500) }); }
  }
  async start(run) {
    await this.update(run, "running", { startedAt: new Date().toISOString() });
    let timer;
    try {
      const adapter = this.adapters[run.adapter];
      const abortController = new AbortController();
      const operation = adapter.run({ repository: run.repository, task: run.task, runId: run.runId, executable: run.executable, signal: abortController.signal, simulationMode: run.simulationMode, routePlan: run.routePlan });
      const adapterCancel = typeof operation.cancel === "function" ? operation.cancel.bind(operation) : null;
      operation.cancel = async () => { abortController.abort(); return (await adapterCancel?.()) || { outcome: "abort_requested" }; };
      this.operations.set(run.runId, operation);
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), run.timeoutMs); });
      const result = await Promise.race([operation, timeout]);
      if (result?.timeout) {
        result.kill = await operation.cancel?.();
        const stopped = await Promise.race([
          operation.catch((error) => ({ exitCode: null, events: [], stderr: error.message })),
          new Promise((resolve) => setTimeout(() => resolve({ exitCode: null, events: [], stderr: "Process did not settle after kill deadline." }), PROCESS_SETTLE_TIMEOUT_MS))
        ]);
        const afterTimeout = await this.git.captureGitState(run.repository);
        run.branchAfter = afterTimeout.branch; run.gitStatusAfter = afterTimeout.status;
        const integrity = this.git.compareGitState(run.gitBefore, afterTimeout);
        if (!integrity.safe) return this.update(run, "failed", { finishedAt: new Date().toISOString(), exitCode: stopped.exitCode, errorSummary: `Read-only integrity check failed after timeout: ${integrity.changed.join(", ")}` });
        return this.update(run, "timed_out", { finishedAt: new Date().toISOString(), exitCode: stopped.exitCode, errorSummary: sanitizeText(`Adapter exceeded timeout. ${result.kill?.outcome || "kill_unknown"}`, 300) });
      }
      if (run.cancelRequested) return run;
      const after = await this.git.captureGitState(run.repository);
      run.branchAfter = after.branch; run.gitStatusAfter = after.status;
      const integrity = this.git.compareGitState(run.gitBefore, after);
      const safeEvents = reduceEvents(result.events);
      if (!integrity.safe) return this.update(run, "failed", { finishedAt: new Date().toISOString(), exitCode: result.exitCode, errorSummary: `Read-only integrity check failed: ${integrity.changed.join(", ")}`, events: safeEvents });
      if (result.exitCode !== 0 || result.issues?.length || !result.resultSummary) return this.update(run, "failed", { finishedAt: new Date().toISOString(), exitCode: result.exitCode, errorSummary: sanitizeText(result.stderr || result.issues?.join(", ") || "No final adapter response.", 500), events: safeEvents });
      return this.update(run, "succeeded", { finishedAt: new Date().toISOString(), exitCode: result.exitCode, resultSummary: sanitizeText(result.resultSummary, MAX_RESULT_LENGTH), events: safeEvents });
    } catch (error) {
      if (run.cancelRequested) return run;
      return this.update(run, "failed", { finishedAt: new Date().toISOString(), errorSummary: sanitizeText(error.message, 500) });
    }
    finally { clearTimeout(timer); this.operations.delete(run.runId); }
  }
  get(runId) { return this.runs.get(runId) || null; }
  async cancel(runId) {
    const run = this.get(runId);
    if (!run || !["validating", "queued", "running"].includes(run.status)) return null;
    const operation = this.operations.get(runId);
    run.cancelRequested = true;
    const kill = await operation?.cancel?.();
    if (!operation) return run;
    await Promise.race([
      operation.catch(() => null),
      new Promise((resolve) => setTimeout(resolve, PROCESS_SETTLE_TIMEOUT_MS))
    ]);
    const after = await this.git.captureGitState(run.repository);
    run.branchAfter = after.branch; run.gitStatusAfter = after.status;
    const integrity = this.git.compareGitState(run.gitBefore, after);
    if (!integrity.safe) return this.update(run, "failed", { finishedAt: new Date().toISOString(), errorSummary: `Read-only integrity check failed after cancellation: ${integrity.changed.join(", ")}` });
    return this.update(run, "cancelled", { finishedAt: new Date().toISOString(), errorSummary: sanitizeText(`Cancelled by user. ${kill?.outcome || "kill_not_needed"}`, 300) });
  }
}
