// J1.2 - Run Dispatcher. The smallest bridge between a validated J1.1 plan
// (planJarvisRequest, ./request-planner.js) and the EXISTING run
// infrastructure (RunService, ../run-service.js). Starts no process itself -
// it only decides whether a plan may become a real run, and if so calls the
// exact same RunService.create() any other caller (POST /api/runs) already
// uses, on the SAME RunService instance, so the resulting run is visible
// through the existing GET /api/runs/:id and /api/history endpoints.
//
// J1.2 executes exactly one taskClass for real: code_analysis, read-only,
// against a resolved project, through the resolved agent's mapped provider
// (codex-local-readonly -> the existing real, read-only Codex adapter, see
// run-service.js's ADAPTER_NAMES / policy.js's EXECUTABLE_PROVIDER_IDS).
// Every other shape fails closed with a RouterError - never a silent mock
// substitution reported as if it were the real thing (2026-08-29 handoff:
// "Keine stillen Fallbacks auf Mock für einen eigentlich ausführbaren
// J1.2-Request, wenn dadurch ein falscher Eindruck entsteht.").
import { RouterError } from "../contracts.js";
import { createRoutePlan } from "../routing-engine.js";

const EXECUTABLE_TASK_CLASS = "code_analysis";
const DISPATCH_ADAPTER = "codex-cli";

// Bounded, HTTP-safe projection of a J1.1 plan. Deliberately drops
// originalRequest/prompt (free user text and the full constructed prompt) -
// the same "no task text leaves the process in a response payload"
// discipline run-summary.js and response-builder.js already apply to runs.
export function safeJarvisPlanView(plan) {
  if (!plan || typeof plan !== "object") return null;
  return {
    intent: plan.intent?.intent ?? null,
    taskType: plan.taskType ?? null,
    taskClass: plan.taskClass ?? null,
    project: plan.project
      ? {
          status: plan.project.status,
          project: plan.project.project ?? null,
          mention: plan.project.mention ?? null,
          candidates: plan.project.candidates ?? null
        }
      : null,
    mode: plan.mode ?? null,
    agent: plan.agent ? { id: plan.agent.id, available: plan.agent.available === true } : null,
    governance: plan.governance
      ? {
          approvalRequired: plan.governance.approvalRequired === true,
          riskLevel: plan.governance.riskLevel ?? null,
          warningsCount: Array.isArray(plan.governance.warnings) ? plan.governance.warnings.length : 0
        }
      : null,
    sessionId: plan.sessionId ?? null
  };
}

// Fail-closed plan validation. Throws a RouterError (never returns a
// downgraded/simulated shape) for anything J1.2 does not execute for real.
function assertExecutable(plan) {
  if (!plan || typeof plan !== "object") throw new RouterError("INVALID_REQUEST", "A Jarvis plan is required.");
  if (plan.taskClass !== EXECUTABLE_TASK_CLASS) {
    throw new RouterError("EXECUTION_DISABLED", `J1.2 only executes taskClass "${EXECUTABLE_TASK_CLASS}" (received "${plan.taskClass}").`);
  }
  if (plan.mode !== "read_only") throw new RouterError("MODE_NOT_ALLOWED", "Only read-only execution is available in J1.2.");
  if (!plan.project || plan.project.status !== "resolved" || !plan.project.project?.path) {
    throw new RouterError("PROJECT_NOT_RESOLVED", `Project must be resolved to a single known repository (status: ${plan.project?.status || "none"}).`);
  }
  if (!plan.agent?.available) throw new RouterError("EXECUTION_DISABLED", "The mapped agent is not available.");
  if (typeof plan.prompt !== "string" || !plan.prompt.trim()) throw new RouterError("INTERNAL_VALIDATION_FAILED", "The plan has no executable prompt.");
  // Defense in depth: RunService.create() is about to run the SAME
  // createRoutePlan(request.task) decision on this exact prompt text. That
  // decision is checked here FIRST, so an approval-gated prompt is refused
  // before any run is created - never silently downgraded to a mock run
  // that would otherwise be reported as if it were the real read-only
  // analysis (see run-service.js's own approvalRequired -> mock downgrade).
  const preflightRoutePlan = createRoutePlan(plan.prompt);
  if (preflightRoutePlan.approvalRequired) {
    throw new RouterError("APPROVAL_REQUIRED", "The generated prompt would require approval; J1.2 never auto-downgrades to a mock run.");
  }
}

// Turns a validated J1.1 plan into a real run on the given RunService
// instance. Throws (fail-closed) rather than returning a mock/simulated run
// for anything outside J1.2's scope; also verifies, after creation, that the
// run actually landed on the real read-only Codex path - the one other
// safety net RunService itself provides (approval-gated tasks are forced to
// "mock" inside RunService.create()) is treated here as a dispatch failure,
// not a quietly-substituted success.
//
// Deliberately does NOT set requestedProvider here. RunService.create()'s
// v0.13 provider layer only maps a MANUALLY selected "codex-local-readonly"
// provider onto the real codex-cli adapter when that provider supports
// every role of the task's workflow (single_provider profile) - but every
// existing workflow type (direct/plan_execute/plan_execute_review, see
// workflow-engine.js's ROLE_SEQUENCES) always includes a role
// (synthesizer/planner) codex-local-readonly's real, narrow role set
// (executor/reviewer only) does not support, so that manual path always
// throws PROVIDER_ROLE_NOT_SUPPORTED today - a pre-existing limitation of
// the provider layer, not something J1.2 should route around. The real,
// already-working path to the real adapter is simply requestedAdapter:
// "codex-cli" with no provider requested: provider selection then stays
// automatic (safe mock-local metadata, uninvolved in adapter choice) and
// adapterName is left exactly as requested - see run-service.js's create(),
// the same path test/run-service.test.js's own real-codex-adapter tests use.
export async function dispatchJarvisRun(plan, { runService, source = "local" } = {}) {
  if (!runService || typeof runService.create !== "function") throw new RouterError("INTERNAL_VALIDATION_FAILED", "A RunService instance is required.");
  assertExecutable(plan);
  const run = await runService.create({
    task: plan.prompt,
    project: plan.project.project.id,
    repository: plan.project.project.path,
    requestedAdapter: DISPATCH_ADAPTER,
    source,
    sessionId: plan.sessionId || null
  });
  // Defense in depth: RunService.create() forces adapterName to "mock" when
  // its own createRoutePlan(request.task) recomputation finds
  // approvalRequired true (see run-service.js), REGARDLESS of the
  // requestedAdapter above. The dispatcher's own preflight check in
  // assertExecutable() should already have caught that and never reached
  // here - this is the last-resort check for anything that check missed.
  if (run.adapter !== DISPATCH_ADAPTER) {
    throw new RouterError("EXECUTION_DISABLED", "The run was not placed on the real read-only Codex path.", {
      safeDetails: { runId: run.runId, adapter: run.adapter }
    });
  }
  return { runId: run.runId, status: run.status, adapter: run.adapter, sessionId: run.sessionId ?? null };
}
