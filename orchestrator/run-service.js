import crypto from "node:crypto";
import { DEFAULT_TIMEOUT_MS, MAX_RESULT_LENGTH, MAX_TASK_LENGTH, PROCESS_SETTLE_TIMEOUT_MS, REPOSITORY_ROOT } from "./config.js";
import { captureGitState, compareGitState } from "./git-safety.js";
import { resolveCodexExecutable, runCodex } from "./codex-adapter.js";
import { saveRun } from "./run-store.js";
import { saveCockpitStatus } from "./cockpit-status.js";
import { reduceEvents, sanitizeText } from "./jsonl.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export class RunService {
  constructor({ adapter = { resolveCodexExecutable, runCodex }, git = { captureGitState, compareGitState }, persist = saveRun, publish = saveCockpitStatus } = {}) {
    this.adapter = adapter; this.git = git; this.persist = persist; this.publish = publish; this.runs = new Map(); this.operations = new Map(); this.activeRunId = null;
  }
  async update(run, status, fields = {}) {
    if (TERMINAL.has(run.status) && run.status !== status) throw new Error("Terminal run state cannot change.");
    run.status = status; Object.assign(run, fields, { updatedAt: new Date().toISOString() });
    await this.persist(run); await this.publish(run); return run;
  }
  async create({ task, repository = REPOSITORY_ROOT, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (typeof task !== "string" || !task.trim() || task.length > MAX_TASK_LENGTH) throw new Error("Task must be a non-empty bounded string.");
    if (this.activeRunId) throw new Error("A Codex run is already active.");
    const run = { runId: `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), task: task.trim(), repository, branchBefore: null, branchAfter: null, gitStatusBefore: null, gitStatusAfter: null, adapter: "codex-cli", executable: null, mode: "read-only", status: "created", startedAt: null, finishedAt: null, timeoutMs, exitCode: null, resultSummary: null, errorSummary: null, usage: null, events: [], warnings: [] };
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
      if (/^(main|master|production)$|^release\//.test(before.branch)) run.warnings.push("Read-only analysis is running on a production-named branch.");
      run.executable = await this.adapter.resolveCodexExecutable();
      await this.update(run, "queued");
      return this.start(run);
    } catch (error) { return this.update(run, "failed", { finishedAt: new Date().toISOString(), errorSummary: sanitizeText(error.message, 500) }); }
  }
  async start(run) {
    await this.update(run, "running", { startedAt: new Date().toISOString() });
    let timer;
    try {
      const operation = this.adapter.runCodex({ repository: run.repository, prompt: run.task, executable: run.executable });
      this.operations.set(run.runId, operation);
      const timeout = new Promise((resolve) => { timer = setTimeout(async () => { const kill = await operation.cancel?.(); resolve({ timeout: true, kill }); }, run.timeoutMs); });
      const result = await Promise.race([operation, timeout]);
      if (result?.timeout) {
        const stopped = await Promise.race([
          operation.catch((error) => ({ exitCode: null, events: [], stderr: error.message })),
          new Promise((resolve) => setTimeout(() => resolve({ exitCode: null, events: [], stderr: "Process did not settle after kill deadline." }), PROCESS_SETTLE_TIMEOUT_MS))
        ]);
        const afterTimeout = await this.git.captureGitState(run.repository);
        run.branchAfter = afterTimeout.branch; run.gitStatusAfter = afterTimeout.status;
        const integrity = this.git.compareGitState(run.gitBefore, afterTimeout);
        if (!integrity.safe) return this.update(run, "failed", { finishedAt: new Date().toISOString(), exitCode: stopped.exitCode, errorSummary: `Read-only integrity check failed after timeout: ${integrity.changed.join(", ")}` });
        return this.update(run, "timed_out", { finishedAt: new Date().toISOString(), exitCode: stopped.exitCode, errorSummary: sanitizeText(`Codex process exceeded timeout. ${result.kill?.outcome || "kill_unknown"}`, 300) });
      }
      if (run.cancelRequested) return run;
      const after = await this.git.captureGitState(run.repository);
      run.branchAfter = after.branch; run.gitStatusAfter = after.status;
      const integrity = this.git.compareGitState(run.gitBefore, after);
      const safeEvents = reduceEvents(result.events);
      if (!integrity.safe) return this.update(run, "failed", { finishedAt: new Date().toISOString(), exitCode: result.exitCode, errorSummary: `Read-only integrity check failed: ${integrity.changed.join(", ")}`, events: safeEvents });
      if (result.exitCode !== 0 || result.issues.length || !result.resultSummary) return this.update(run, "failed", { finishedAt: new Date().toISOString(), exitCode: result.exitCode, errorSummary: sanitizeText(result.stderr || result.issues.join(", ") || "No final Codex response.", 500), events: safeEvents });
      return this.update(run, "succeeded", { finishedAt: new Date().toISOString(), exitCode: result.exitCode, resultSummary: sanitizeText(result.resultSummary, MAX_RESULT_LENGTH), events: safeEvents });
    } catch (error) { return this.update(run, "failed", { finishedAt: new Date().toISOString(), errorSummary: sanitizeText(error.message, 500) }); }
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
