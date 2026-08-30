import crypto from "node:crypto";
import { CODEX_RUN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MAX_EVENT_COUNT, MAX_JSONL_LINE_LENGTH, MAX_RESULT_LENGTH, MOCK_TIMEOUT_MS, PROCESS_SETTLE_TIMEOUT_MS, REPOSITORY_ROOT } from "./config.js";
import { captureGitState, compareGitState } from "./git-safety.js";
import { CODEX_SAFETY_INSTRUCTION, resolveCodexExecutable, runCodex } from "./codex-adapter.js";
import { buildAdapterInput, buildAdapterOutput } from "./adapter-contract.js";
import { saveRun } from "./run-store.js";
import { saveCockpitStatus } from "./cockpit-status.js";
import { reduceEvents, sanitizeText } from "./jsonl.js";
import { isMockSimulationMode, runMock, runMockRole } from "./mock-adapter.js";
import { createApprovalContext, createRoutePlan } from "./routing-engine.js";
import { cancelWorkflow, completeWorkflow, createWorkflow, failStep, nextPendingStep, startStep, succeedStep } from "./workflow-engine.js";
import { normalizeRunRequest, RouterError } from "./contracts.js";
import { logger as defaultLogger } from "./logger.js";
import { ERROR_CODES } from "./policy.js";
import { createAdapterStatusMonitor } from "./adapter-status.js";
import { selectProvider } from "./provider-selection.js";
import { flavorRoleResult } from "./provider-simulator.js";
import { synthesizeProviderResults } from "./provider-synthesis.js";
import { providerRegistry } from "./provider-registry.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const ACTIVE = new Set(["validating", "queued", "running"]);
const FAILED = new Set(["failed", "timed_out"]);
const ADAPTER_NAMES = new Set(["mock", "codex-cli"]);
const CODEX_START_RETRY_ERROR_CODE = "CODEX_PROCESS_START_FAILED";
// Bug D (2026-08-30): the real codex-cli process can legitimately produce a
// complete, successful result while ALSO tripping one of these two, verified
// non-fatal parser/process conditions:
//   - stderr_truncated: a verbose, non-fatal internal Codex log line can
//     exceed MAX_STDERR_LENGTH (see codex-adapter.js).
//   - jsonl_line_too_large: a large intermediate JSONL line (observed: a
//     tool-output/file-read event, not the final answer) can exceed
//     MAX_JSONL_LINE_LENGTH and gets dropped by the parser (see jsonl.js) -
//     confirmed via a real "Prüf den AI-Router" run whose final
//     item.completed/agent_message text was complete and unaffected.
// Treating either alone (or both together) as fatal turned a genuinely
// successful, complete analysis into a false "failed". These are the ONLY
// issues ever excluded from the fatal check below - every other adapter
// issue, and any of these combined with an unlisted issue, stays fatal.
const NON_FATAL_ADAPTER_ISSUES = new Set(["stderr_truncated", "jsonl_line_too_large"]);
function hasFatalAdapterIssues(issues) {
  return Array.isArray(issues) && issues.some((issue) => !NON_FATAL_ADAPTER_ISSUES.has(issue));
}

function runCodexContract({ repository, task, runId, executable, retryAttempt = 0 }) {
  const input = buildAdapterInput({
    adapter: "codex-cli",
    requestId: runId,
    runId,
    taskType: "read_only_codex",
    safeInstruction: CODEX_SAFETY_INSTRUCTION,
    workingDirectory: repository,
    timeoutMs: CODEX_RUN_TIMEOUT_MS,
    maxOutputBytes: MAX_JSONL_LINE_LENGTH,
    retryAttempt
  });
  return runCodex({ repository: input.workingDirectory, prompt: task, executable, maxOutputBytes: input.maxOutputBytes });
}

function defaultAdapters() {
  return {
    mock: { run: runMock, runRole: runMockRole },
    "codex-cli": { resolveExecutable: resolveCodexExecutable, run: runCodexContract }
  };
}

export class RunService {
  constructor({ adapters, adapter, git = { captureGitState, compareGitState }, persist = saveRun, publish = saveCockpitStatus, logger = defaultLogger, adapterStatus, registry } = {}) {
    this.adapters = adapters || (adapter ? { "codex-cli": { resolveExecutable: adapter.resolveCodexExecutable, run: ({ repository, task, executable }) => adapter.runCodex({ repository, prompt: task, executable }) } } : defaultAdapters());
    this.defaultAdapter = adapter ? "codex-cli" : "mock";
    this.git = git; this.persist = persist; this.publish = publish; this.logger = logger; this.runs = new Map(); this.operations = new Map(); this.activeRunId = null;
    this.adapterStatus = adapterStatus || createAdapterStatusMonitor();
    this.registry = registry || providerRegistry;
  }
  // Deterministic provider selection wrapper: normalizes any failure into the
  // safe provider error contract and logs the outcome. Never bypasses approval.
  selectProviderPlan(routePlan, request) {
    this.log("provider_selection_started", { requestId: request.requestId, runId: null }, "created", { taskType: routePlan.taskType });
    try {
      const plan = selectProvider({ routePlan, request, registry: this.registry });
      this.log("provider_selected", { requestId: request.requestId, runId: null }, "created", { providerId: plan.selectedProviderId, profile: plan.providerWorkflowProfile, mode: plan.selectionMode });
      return plan;
    } catch (error) {
      this.log("provider_selection_failed", { requestId: request.requestId, runId: null }, "failed", { code: error.code || "PROVIDER_SELECTION_FAILED" });
      throw error instanceof RouterError ? error : new RouterError("PROVIDER_SELECTION_FAILED", "Provider selection failed.");
    }
  }
  log(event, run, status, safeMetadata = {}) {
    const { providerId = null, modelId = null, role = null, ...rest } = safeMetadata || {};
    return this.logger?.log?.({ event, requestId: run?.requestId || null, runId: run?.runId || null, workflowId: run?.workflow?.type || null, stepId: run?.workflow?.currentStep || null, providerId, modelId, role, status, safeMetadata: rest }).catch(() => {});
  }
  // Live, in-memory operational snapshot for this process. Safe counters and
  // timestamps only — no task content, prompts, paths or raw errors.
  snapshot() {
    const runs = [...this.runs.values()];
    const byFinishedDesc = (a, b) => (Date.parse(b.finishedAt || "") || 0) - (Date.parse(a.finishedAt || "") || 0);
    const byUpdatedDesc = (a, b) => (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0);
    const lastFailed = runs.filter((run) => FAILED.has(run.status) && run.finishedAt).sort(byFinishedDesc)[0] || null;
    const lastSuccess = runs.filter((run) => run.status === "succeeded" && run.finishedAt).sort(byFinishedDesc)[0] || null;
    const lastCode = lastFailed ? (ERROR_CODES.includes(lastFailed.errorCode) ? lastFailed.errorCode : (lastFailed.status === "timed_out" ? "STEP_TIMEOUT" : "ADAPTER_FAILED")) : null;
    const mostRecent = runs.slice().sort(byUpdatedDesc)[0] || null;
    return {
      serviceStatus: "ok",
      activeRuns: runs.filter((run) => ACTIVE.has(run.status)).length,
      queuedRuns: runs.filter((run) => run.status === "queued").length,
      awaitingApprovalRuns: runs.filter((run) => run.status === "awaiting_approval").length,
      lastSuccessfulRunAt: lastSuccess?.finishedAt || null,
      lastFailedRunAt: lastFailed?.finishedAt || null,
      lastSafeErrorCode: lastCode,
      lastRunStatus: mostRecent?.status || null
    };
  }
  // Context for the read-only cockpit contract. Uses only the cached adapter
  // status (never triggers a fresh probe from a normal run update).
  cockpitContext() {
    const snapshot = this.snapshot();
    const adapterStatus = this.adapterStatus.current();
    return { ...snapshot, adapterStatus, checkedAt: adapterStatus["codex-cli"]?.checkedAt || new Date().toISOString(), providerLayer: this.registry.status() };
  }
  async update(run, status, fields = {}) {
    if (TERMINAL.has(run.status) && run.status !== status) throw new Error("Terminal run state cannot change.");
    run.status = status; Object.assign(run, fields, { updatedAt: new Date().toISOString() });
    if (TERMINAL.has(status)) {
      const output = buildAdapterOutput({ adapter: run.adapter, status, success: status === "succeeded", exitCode: Number.isFinite(run.exitCode) ? run.exitCode : null, startedAt: run.startedAt, finishedAt: run.finishedAt, retryable: false, warnings: run.warnings });
      run.durationMs = output.durationMs;
    }
    await this.persist(run); await this.publish(this.cockpitContext()); this.log(status === "failed" ? "run_failed" : (TERMINAL.has(status) ? "run_completed" : "workflow_started"), run, status); return run;
  }
  async create(input = {}) {
    const request = normalizeRunRequest({ ...input, requestedAdapter: input.requestedAdapter ?? input.adapter ?? this.defaultAdapter });
    const { task, repository = REPOSITORY_ROOT } = input;
    const routePlan = createRoutePlan(request.task);
    // v0.13: deterministic provider selection (metadata + optional manual choice).
    const providerPlan = this.selectProviderPlan(routePlan, request);
    let adapterName = request.requestedAdapter || this.defaultAdapter;
    // A manual codex-local-readonly selection maps to the existing real read-only
    // codex adapter path (all v0.11 safety intact). Simulated providers stay on mock.
    if (providerPlan.selectedProviderId === "codex-local-readonly" && providerPlan.selectedAdapterId === "codex-cli-readonly") adapterName = "codex-cli";
    else if (request.requestedProvider && providerPlan.selectedAdapterId === "mock") adapterName = "mock";
    if (!ADAPTER_NAMES.has(adapterName) || !this.adapters[adapterName]) throw new Error("Unsupported adapter.");
    const simulationMode = request.options.simulationMode;
    if (adapterName === "mock" && simulationMode !== undefined && !isMockSimulationMode(simulationMode)) throw new RouterError("INVALID_REQUEST", "Unsupported simulation mode.");
    if (adapterName !== "mock" && simulationMode !== undefined) throw new RouterError("INVALID_REQUEST", "Simulation mode is only available for the mock adapter.");
    if (routePlan.approvalRequired && adapterName !== "mock") {
      adapterName = "mock";
      routePlan.warnings.push("Der angeforderte Adapter wurde wegen des Freigabe-Gates durch eine reine Simulation ersetzt.");
    }
    routePlan.executionAdapter = adapterName;
    if (this.activeRunId) throw new Error("A router run is already active.");
    const mode = adapterName === "mock" ? (simulationMode || "success") : null;
    // Codex gets its own, longer budget (CODEX_RUN_TIMEOUT_MS) - a real
    // read-only repo analysis routinely needs more than DEFAULT_TIMEOUT_MS.
    // Every mock/simulated workflow run keeps DEFAULT_TIMEOUT_MS exactly as
    // before (MOCK_TIMEOUT_MS only for the dedicated timeout-simulation mode).
    const timeoutMs = adapterName === "codex-cli" ? CODEX_RUN_TIMEOUT_MS : (adapterName === "mock" && mode === "timeout" ? MOCK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const createdAt = new Date().toISOString();
    const approvalContext = createApprovalContext(request.task, routePlan);
    const approval = routePlan.approvalRequired ? { required: true, status: "pending", requestedAt: createdAt, decidedAt: null, decision: null, decisionNote: "", approvedAction: "", consumed: false } : null;
    const workflow = createWorkflow(routePlan);
    if (mode === "failure_reviewer" && !workflow.steps.some((step) => step.role === "reviewer")) throw new Error("Reviewer failure simulation requires a reviewer workflow.");
    const run = { runId: `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`, ...request, createdAt, updatedAt: createdAt, task: request.task, repository, sessionId: request.sessionId || null, branchBefore: null, branchAfter: null, gitStatusBefore: null, gitStatusAfter: null, adapter: adapterName, simulationMode: mode, executable: null, mode: "read-only", status: "created", startedAt: null, finishedAt: null, durationMs: null, timeoutMs, exitCode: null, resultSummary: null, errorCode: null, errorSummary: null, usage: null, events: [], retry: { count: 0, maxAttempts: 2, lastReason: null }, warnings: [...routePlan.warnings], routePlan, approvalContext, approval, approvalSimulation: false, workflow, providerPlan, providerWorkflowProfile: providerPlan.providerWorkflowProfile, providerRuntime: { providersUsed: [providerPlan.selectedProviderId], realLocalAdapterUsed: false }, providerSynthesis: null };
    this.activeRunId = run.runId;
    this.runs.set(run.runId, run);
    try { await this.persist(run); await this.publish(this.cockpitContext()); }
    catch (error) {
      this.runs.delete(run.runId);
      if (this.activeRunId === run.runId) this.activeRunId = null;
      throw error;
    }
    this.log("request_received", run, "created");
    this.execute(run).finally(() => { if (this.activeRunId === run.runId) this.activeRunId = null; });
    return run;
  }
  async execute(run) {
    await this.update(run, "validating");
    try {
      if (run.adapter === "mock") {
        if (run.cancelRequested) { cancelWorkflow(run.workflow); return this.update(run, "cancelled", { finishedAt: new Date().toISOString(), resultSummary: "Mock-Workflow abgebrochen. Es wurde keine reale Aktion ausgeführt." }); }
        if (run.routePlan?.approvalRequired) {
          const waiting = await this.update(run, "awaiting_approval", { finishedAt: new Date().toISOString(), resultSummary: "Freigabe erforderlich. Workflow wurde vorbereitet, aber nicht gestartet; die erkannte Aktion wurde nicht ausgeführt." });
          if (this.activeRunId === run.runId) this.activeRunId = null;
          return waiting;
        }
        await this.update(run, "queued");
        return this.startMockWorkflow(run);
      }
      const before = await this.git.captureGitState(run.repository);
      run.repository = before.repository; run.branchBefore = before.branch; run.gitStatusBefore = before.status; run.gitBefore = before;
      if (run.cancelRequested) return this.update(run, "cancelled", { branchAfter: before.branch, gitStatusAfter: before.status, finishedAt: new Date().toISOString(), errorSummary: "Cancelled by user." });
      if (run.routePlan?.approvalRequired) {
        const waiting = await this.update(run, "awaiting_approval", { branchAfter: before.branch, gitStatusAfter: before.status, finishedAt: new Date().toISOString(), resultSummary: "Freigabe erforderlich. Der Route-Plan wurde gespeichert; die erkannte Aktion wurde nicht ausgeführt." });
        if (this.activeRunId === run.runId) this.activeRunId = null;
        return waiting;
      }
      if (/^(main|master|production)$|^release\//.test(before.branch)) run.warnings.push("Read-only analysis is running on a production-named branch.");
      const adapter = this.adapters[run.adapter];
      if (adapter.resolveExecutable) run.executable = await adapter.resolveExecutable();
      await this.update(run, "queued");
      return this.start(run);
    } catch (error) { return this.update(run, "failed", { finishedAt: new Date().toISOString(), errorCode: error.code || null, errorSummary: sanitizeText(error.message, 500) }); }
  }
  async start(run) {
    await this.update(run, "running", { startedAt: new Date().toISOString() });
    // This is the only real (local, read-only) adapter path.
    if (run.providerRuntime) { run.providerRuntime.realLocalAdapterUsed = true; run.providerRuntime.providersUsed = ["codex-local-readonly"]; }
    const adapter = this.adapters[run.adapter];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let timer;
      try {
        const abortController = new AbortController();
        const operation = adapter.run({ repository: run.repository, task: run.task, runId: run.runId, executable: run.executable, signal: abortController.signal, simulationMode: run.simulationMode, routePlan: run.routePlan, retryAttempt: attempt - 1 });
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
          if (!integrity.safe) return this.update(run, "failed", { finishedAt: new Date().toISOString(), exitCode: stopped.exitCode, errorCode: "READ_ONLY_VIOLATION_DETECTED", errorSummary: `Read-only integrity check failed after timeout: ${integrity.changed.join(", ")}` });
          return this.update(run, "timed_out", { finishedAt: new Date().toISOString(), exitCode: stopped.exitCode, errorCode: "STEP_TIMEOUT", errorSummary: sanitizeText(`Adapter exceeded timeout. ${result.kill?.outcome || "kill_unknown"}`, 300) });
        }
        if (run.cancelRequested) return run;
        const after = await this.git.captureGitState(run.repository);
        run.branchAfter = after.branch; run.gitStatusAfter = after.status;
        const integrity = this.git.compareGitState(run.gitBefore, after);
        const safeEvents = reduceEvents(result.events);
        if (!integrity.safe) return this.update(run, "failed", { finishedAt: new Date().toISOString(), exitCode: result.exitCode, errorCode: "READ_ONLY_VIOLATION_DETECTED", errorSummary: `Read-only integrity check failed: ${integrity.changed.join(", ")}`, events: safeEvents });
        if (result.exitCode !== 0 || hasFatalAdapterIssues(result.issues) || !result.resultSummary) return this.update(run, "failed", { finishedAt: new Date().toISOString(), exitCode: result.exitCode, errorCode: "ADAPTER_FAILED", errorSummary: sanitizeText(result.stderr || result.issues?.join(", ") || "No final adapter response.", 500), events: safeEvents });
        // stderr_truncated (the one non-fatal issue) is kept visible as a
        // warning rather than silently dropped - same bounded, safe-text
        // shape every other run warning already uses.
        if (result.issues?.includes("stderr_truncated")) run.warnings = [...run.warnings, "Adapter-Ausgabe (stderr) wurde beim Sammeln gekuerzt; das Endergebnis war dennoch vollstaendig."];
        return this.update(run, "succeeded", { finishedAt: new Date().toISOString(), exitCode: result.exitCode, resultSummary: sanitizeText(result.resultSummary, MAX_RESULT_LENGTH), events: safeEvents });
      } catch (error) {
        if (run.cancelRequested) return run;
        if (error.code === CODEX_START_RETRY_ERROR_CODE && attempt === 1) {
          run.retry.count += 1; run.retry.lastReason = "process_start_failed";
          this.log("step_failed", run, "retrying", { retry: "1" });
          continue;
        }
        return this.update(run, "failed", { finishedAt: new Date().toISOString(), errorCode: error.code || null, errorSummary: sanitizeText(error.message, 500) });
      }
      finally { clearTimeout(timer); this.operations.delete(run.runId); }
    }
  }
  async startMockWorkflow(run, { approvalSimulation = false } = {}) {
    run.approvalSimulation = approvalSimulation;
    await this.update(run, "running", { startedAt: run.startedAt || new Date().toISOString(), finishedAt: null });
    const adapter = this.adapters.mock;
    if (!adapter) return this.update(run, "failed", { finishedAt: new Date().toISOString(), errorSummary: "Safe mock adapter is unavailable." });
    let finalSummary = "";
    const providerRoleResults = [];
    try {
      let step = nextPendingStep(run.workflow);
      while (step) {
        if (run.cancelRequested) return run;
        startStep(run.workflow, step.id);
        await this.update(run, "running");
        const assignment = run.providerPlan?.roleAssignments?.find((a) => a.role === step.role) || null;
        const runRole = adapter.runRole || ((options) => adapter.run({ ...options, workflowRole: options.role }));
        let result; let operation;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const abortController = new AbortController();
          operation = runRole({ role: step.role, task: run.task, runId: run.runId, signal: abortController.signal, simulationMode: approvalSimulation ? "success" : run.simulationMode, approvalSimulation, attempt });
          operation.cancel = async () => { abortController.abort(); return { outcome: "abort_requested" }; };
          this.operations.set(run.runId, operation);
          let timer;
          const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), run.timeoutMs); });
          try { result = await Promise.race([operation, timeout]); }
          catch (error) { if (run.cancelRequested) return run; result = { exitCode: 1, issues: [], stderr: error.message, events: [], resultSummary: null }; }
          finally { clearTimeout(timer); this.operations.delete(run.runId); }
          if (result?.timeout || (result.exitCode === 0 && !result.issues?.length && result.resultSummary)) break;
          if (attempt === 1) {
            run.retry.count += 1; run.retry.lastReason = "adapter_failed";
            this.log("step_failed", run, "retrying", { retry: "1" });
            await this.update(run, "running");
          }
        }

        // v0.13: reflavor a successful role result with its assigned simulated
        // provider profile. Timeouts and the baseline mock provider pass through.
        if (assignment && result && !result.timeout) result = flavorRoleResult(result, { providerId: assignment.providerId, modelId: assignment.modelId, role: step.role, simulationProfile: assignment.providerId });

        if (result?.timeout) {
          await operation.cancel();
          failStep(run.workflow, step.id, "Workflow step exceeded timeout.");
          this.log("step_failed", run, "timed_out");
          return this.update(run, "timed_out", { finishedAt: new Date().toISOString(), errorCode: "STEP_TIMEOUT", errorSummary: `Workflow step timed out: ${step.role}.` });
        }
        const safeEvents = [...run.events, ...reduceEvents(result.events)].slice(-MAX_EVENT_COUNT);
        if (result.exitCode !== 0 || result.issues?.length || !result.resultSummary) {
          const errorSummary = sanitizeText(result.stderr || result.issues?.join(", ") || "Workflow step produced no result.", 500);
          failStep(run.workflow, step.id, errorSummary);
          this.log("step_failed", run, "failed");
          return this.update(run, "failed", { finishedAt: new Date().toISOString(), exitCode: result.exitCode, errorCode: "STEP_FAILED", errorSummary, events: safeEvents });
        }
        succeedStep(run.workflow, step.id, result.resultSummary);
        this.log("step_completed", run, "succeeded");
        finalSummary = result.resultSummary;
        providerRoleResults.push({ role: step.role, providerId: assignment?.providerId || "mock-local", simulated: assignment?.simulated ?? true, summary: result.resultSummary, status: "succeeded" });
        await this.update(run, "running", { events: safeEvents });
        step = nextPendingStep(run.workflow);
      }
      completeWorkflow(run.workflow);
      // v0.13: record which providers actually ran and, for multi-provider
      // chains, a safe synthesis with agreements/disagreements.
      if (run.providerRuntime) run.providerRuntime.providersUsed = [...new Set(providerRoleResults.map((r) => r.providerId))];
      if (run.providerWorkflowProfile && run.providerWorkflowProfile !== "single_provider") {
        run.providerSynthesis = synthesizeProviderResults({ workflowProfile: run.providerWorkflowProfile, roleResults: providerRoleResults, uncertainty: run.routePlan?.uncertainty });
        this.log("provider_result_synthesized", run, "succeeded", { profile: run.providerWorkflowProfile, providers: String(run.providerRuntime.providersUsed.length) });
      }
      return this.update(run, "succeeded", { finishedAt: new Date().toISOString(), exitCode: 0, resultSummary: sanitizeText(finalSummary, MAX_RESULT_LENGTH), errorSummary: null });
    } catch (error) {
      if (run.cancelRequested) return run;
      const runningStep = run.workflow.steps.find((item) => item.status === "running");
      if (runningStep) failStep(run.workflow, runningStep.id, error.message);
      return this.update(run, "failed", { finishedAt: new Date().toISOString(), errorCode: error.code || null, errorSummary: sanitizeText(error.message, 500) });
    } finally { this.operations.delete(run.runId); }
  }
  get(runId) { return this.runs.get(runId) || null; }
  async decideApproval(runId, { decision, decisionNote = "" } = {}) {
    const run = this.get(runId);
    if (!run) throw new Error("Run not found.");
    if (run.status !== "awaiting_approval" || !run.approval?.required) throw new Error("Run is not awaiting approval.");
    if (run.approval.consumed || run.approval.status !== "pending") throw new Error("Approval decision has already been consumed.");
    if (!new Set(["approve", "reject"]).has(decision)) throw new Error("Approval decision must be approve or reject.");
    if (typeof decisionNote !== "string" || decisionNote.length > 1_000) throw new Error("Decision note must be a bounded string.");
    if (decision === "approve" && this.activeRunId) throw new Error("Another router run is already active.");

    const decidedAt = new Date().toISOString();
    const approved = decision === "approve";
    run.approval.status = approved ? "approved" : "rejected";
    run.approval.decidedAt = decidedAt;
    run.approval.decision = approved ? "approved" : "rejected";
    run.approval.decisionNote = sanitizeText(decisionNote, 500) || "";
    run.approval.approvedAction = approved ? sanitizeText(run.approvalContext?.plannedAction, 300) || "" : "";
    run.approval.consumed = true;
    run.events = [...run.events, { timestamp: decidedAt, type: "approval_decision", status: run.approval.status, messageSummary: approved ? "Local approval registered for safe simulation." : "Local approval rejected." }].slice(-MAX_EVENT_COUNT);

    if (!approved) { cancelWorkflow(run.workflow, decidedAt); return this.update(run, "cancelled", { finishedAt: decidedAt, resultSummary: "Freigabe abgelehnt. Es wurde keine Aktion ausgeführt.", errorSummary: null }); }

    this.activeRunId = run.runId;
    run.approvalSimulation = true;
    try {
      await this.update(run, "queued", { finishedAt: null, resultSummary: "Freigabe registriert. Sichere Simulation wird vorbereitet.", errorSummary: null });
    } catch (error) {
      if (this.activeRunId === run.runId) this.activeRunId = null;
      throw error;
    }
    this.startApprovalSimulation(run).finally(() => { if (this.activeRunId === run.runId) this.activeRunId = null; });
    return run;
  }
  async startApprovalSimulation(run) {
    return this.startMockWorkflow(run, { approvalSimulation: true });
  }
  async cancel(runId) {
    const run = this.get(runId);
    // Only running or waiting runs are cancellable; finished runs are immutable.
    // Returning null here keeps repeated cancels idempotent.
    if (!run || !ACTIVE.has(run.status)) return null;
    this.log("run_cancel_requested", run, run.status);
    const operation = this.operations.get(runId);
    run.cancelRequested = true;
    const isMockRun = run.adapter === "mock";
    const kill = await operation?.cancel?.();
    if (!operation) {
      if (isMockRun && run.workflow) { cancelWorkflow(run.workflow); const done = await this.update(run, "cancelled", { finishedAt: new Date().toISOString(), resultSummary: "Mock-Workflow abgebrochen. Es wurde keine reale Aktion ausgeführt.", errorSummary: null }); this.log("run_cancel_completed", run, "cancelled"); return done; }
      const done = await this.update(run, "cancelled", { finishedAt: new Date().toISOString(), errorSummary: "Cancelled by user before the adapter started." });
      this.log("run_cancel_completed", run, "cancelled");
      return done;
    }
    await Promise.race([
      operation.catch(() => null),
      new Promise((resolve) => setTimeout(resolve, PROCESS_SETTLE_TIMEOUT_MS))
    ]);
    if (isMockRun) {
      if (run.workflow) cancelWorkflow(run.workflow);
      const done = await this.update(run, "cancelled", { finishedAt: new Date().toISOString(), resultSummary: run.approvalSimulation ? "Freigabe-Simulation abgebrochen. Es wurde keine Aktion ausgeführt." : "Mock-Workflow abgebrochen. Es wurde keine reale Aktion ausgeführt.", errorSummary: null });
      this.log("run_cancel_completed", run, "cancelled");
      return done;
    }
    // Read-only post-check is preserved even on cancellation of a real run.
    const after = await this.git.captureGitState(run.repository);
    run.branchAfter = after.branch; run.gitStatusAfter = after.status;
    const integrity = this.git.compareGitState(run.gitBefore, after);
    if (!integrity.safe) { const failed = await this.update(run, "failed", { finishedAt: new Date().toISOString(), errorCode: "READ_ONLY_VIOLATION_DETECTED", errorSummary: `Read-only integrity check failed after cancellation: ${integrity.changed.join(", ")}` }); this.log("run_cancel_failed", run, "failed"); return failed; }
    const done = await this.update(run, "cancelled", { finishedAt: new Date().toISOString(), errorSummary: sanitizeText(`Cancelled by user. ${kill?.outcome || "kill_not_needed"}`, 300) });
    this.log("run_cancel_completed", run, "cancelled");
    return done;
  }
}
