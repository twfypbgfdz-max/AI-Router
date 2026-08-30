import test from "node:test";
import assert from "node:assert/strict";
import { RunService } from "../orchestrator/run-service.js";
import { planJarvisRequest } from "../orchestrator/jarvis/request-planner.js";
import { dispatchJarvisRun, safeJarvisPlanView } from "../orchestrator/jarvis/run-dispatcher.js";

const GIT_STATE = { repository: "C:\\Users\\felil\\Documents\\KI\\AI-Router", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" };

function fakeRunService({ runCodex } = {}) {
  return new RunService({
    adapter: {
      resolveCodexExecutable: async () => "codex",
      runCodex: runCodex || (async () => ({ exitCode: 0, issues: [], stderr: "", events: [{ text: "ok" }], resultSummary: "AI-Router looks fine." }))
    },
    git: { captureGitState: async () => GIT_STATE, compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {},
    publish: async () => {}
  });
}

function hasCode(code) { return (error) => error?.code === code; }

async function waitForTerminal(service, runId) {
  for (let i = 0; i < 50; i += 1) {
    const run = service.get(runId);
    if (["succeeded", "failed", "cancelled", "timed_out", "awaiting_approval"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Run did not reach a terminal state in time.");
}

// 1. code_analysis + resolved AI-Router -> a real codex-cli run request.
test("1. code_analysis on a resolved project dispatches a real codex-cli run", async () => {
  const plan = planJarvisRequest({ question: "Prüf den AI-Router." });
  assert.equal(plan.taskClass, "code_analysis");
  const service = fakeRunService();
  const dispatch = await dispatchJarvisRun(plan, { runService: service });
  assert.equal(dispatch.adapter, "codex-cli");
  const run = await waitForTerminal(service, dispatch.runId);
  assert.equal(run.status, "succeeded");
  assert.equal(run.adapter, "codex-cli");
  assert.equal(run.repository, plan.project.project.path);
});

// 2. sessionId is correctly threaded through to the run.
test("2. sessionId passes through to the created run", async () => {
  const plan = planJarvisRequest({ question: "Prüf den AI-Router.", sessionId: "sess-abc123" });
  const service = fakeRunService();
  const dispatch = await dispatchJarvisRun(plan, { runService: service });
  assert.equal(dispatch.sessionId, "sess-abc123");
  assert.equal(service.get(dispatch.runId).sessionId, "sess-abc123");
});

// 3. A run without a sessionId stays allowed and yields sessionId: null.
test("3. no sessionId is still allowed and yields a null-correlated run", async () => {
  const plan = planJarvisRequest({ question: "Prüf den AI-Router." });
  assert.equal(plan.sessionId, null);
  const service = fakeRunService();
  const dispatch = await dispatchJarvisRun(plan, { runService: service });
  assert.equal(dispatch.sessionId, null);
  assert.equal(service.get(dispatch.runId).sessionId, null);
});

// 4. code_implementation is never executed.
test("4. code_implementation is rejected before any run is created", async () => {
  const plan = planJarvisRequest({ question: "Beheb den Fehler im AI-Router." });
  assert.equal(plan.taskClass, "code_implementation");
  const service = fakeRunService();
  await assert.rejects(dispatchJarvisRun(plan, { runService: service }), hasCode("EXECUTION_DISABLED"));
  assert.equal(service.runs.size, 0);
});

// 5. write mode is rejected outright, even for an otherwise well-formed plan.
test("5. write mode is rejected", async () => {
  const plan = planJarvisRequest({ question: "Prüf den AI-Router." });
  const writePlan = { ...plan, mode: "write" };
  const service = fakeRunService();
  await assert.rejects(dispatchJarvisRun(writePlan, { runService: service }), hasCode("MODE_NOT_ALLOWED"));
  assert.equal(service.runs.size, 0);
});

// 6. an unknown project never even becomes code_analysis (J1.1's own
// classifyTaskClass only assigns code_analysis when a project resolved) -
// fails closed at the taskClass gate, before the dispatcher ever looks at
// the project field.
test("6. unknown project never becomes code_analysis and is rejected", async () => {
  const plan = planJarvisRequest({ question: "Prüf das Projekt Foobar." });
  assert.equal(plan.project.status, "unknown");
  assert.notEqual(plan.taskClass, "code_analysis");
  const service = fakeRunService();
  await assert.rejects(dispatchJarvisRun(plan, { runService: service }), hasCode("EXECUTION_DISABLED"));
  assert.equal(service.runs.size, 0);
});

// 6b. Defense in depth: even a plan that CLAIMS taskClass "code_analysis"
// (e.g. mutated, or a future caller that builds one directly rather than
// through planJarvisRequest) is refused if its project never actually
// resolved to a single known repository.
test("6b. a code_analysis plan with an unresolved project still fails closed (defense in depth)", async () => {
  const plan = planJarvisRequest({ question: "Prüf den AI-Router." });
  const unresolvedPlan = { ...plan, project: { status: "unknown", mention: "foobar" } };
  const service = fakeRunService();
  await assert.rejects(dispatchJarvisRun(unresolvedPlan, { runService: service }), hasCode("PROJECT_NOT_RESOLVED"));
  assert.equal(service.runs.size, 0);
});

// 7. an ambiguous project never becomes code_analysis either - same gate as #6.
test("7. ambiguous project never becomes code_analysis and is rejected", async () => {
  const plan = planJarvisRequest({ question: "Prüf die Trainingsapp." });
  assert.equal(plan.project.status, "ambiguous");
  assert.notEqual(plan.taskClass, "code_analysis");
  const service = fakeRunService();
  await assert.rejects(dispatchJarvisRun(plan, { runService: service }), hasCode("EXECUTION_DISABLED"));
  assert.equal(service.runs.size, 0);
});

// 8. an unavailable agent fails closed, even if everything else looks executable.
test("8. an unavailable agent fails closed", async () => {
  const plan = planJarvisRequest({ question: "Prüf den AI-Router." });
  const unavailablePlan = { ...plan, agent: { ...plan.agent, available: false } };
  const service = fakeRunService();
  await assert.rejects(dispatchJarvisRun(unavailablePlan, { runService: service }), hasCode("EXECUTION_DISABLED"));
  assert.equal(service.runs.size, 0);
});

// 9 + 10. the adapter/provider mapping is hardcoded - nothing from the plan
// (which is ultimately derived from free user text) can steer
// requestedAdapter/requestedProvider to a different value. requestedProvider
// is deliberately never set at all (see run-dispatcher.js's own comment on
// why the v0.13 manual-provider path cannot serve codex-local-readonly for
// any real workflow today).
test("9+10. the dispatched run request always uses a fixed codex-cli adapter and no free-form provider", async () => {
  const plan = planJarvisRequest({ question: "Prüf den AI-Router." });
  const tamperedPlan = { ...plan, agent: { ...plan.agent, id: "claude-code" } };
  const service = fakeRunService();
  const created = [];
  const originalCreate = service.create.bind(service);
  service.create = async (input) => { created.push(input); return originalCreate(input); };
  await dispatchJarvisRun(tamperedPlan, { runService: service });
  assert.equal(created.length, 1);
  assert.equal(created[0].requestedAdapter, "codex-cli");
  assert.equal(created[0].requestedProvider, undefined);
});

test("safeJarvisPlanView never carries the raw prompt or originalRequest text", () => {
  const plan = planJarvisRequest({ question: "Prüf den AI-Router." });
  const view = safeJarvisPlanView(plan);
  const serialized = JSON.stringify(view);
  assert.ok(!("prompt" in view));
  assert.ok(!("originalRequest" in view));
  assert.ok(!serialized.includes("Prüf den AI-Router"));
});

test("a plan whose prompt text alone would trip the approval gate is refused before any run is created", async () => {
  // J1.1's own governance field is computed from the short ORIGINAL question
  // (see request-planner.js), not from the full generated prompt that
  // actually becomes the run's task text. dispatchJarvisRun's own preflight
  // check re-evaluates that prompt text and must refuse it before
  // RunService.create() would otherwise silently downgrade it to a mock run.
  const plan = planJarvisRequest({ question: "Prüf den AI-Router." });
  const dangerousPlan = { ...plan, prompt: "Bitte committe und pushe die Änderungen im AI-Router." };
  const service = fakeRunService();
  await assert.rejects(dispatchJarvisRun(dangerousPlan, { runService: service }), hasCode("APPROVAL_REQUIRED"));
  assert.equal(service.runs.size, 0);
});
