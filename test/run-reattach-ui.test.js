// R12 - Run Resume/Reattach after browser reload. Before this, the v0.13
// approval UI (01_APP/tests/ai-router-v0_13-test.html, served at GET /) held
// `activeRunId` only as an in-memory JS variable: a page reload during a
// running or awaiting_approval run lost it, even though the server (via
// RunService.activeRunId + the persisted run store) still had the run alive.
// The fix re-derives the relevant run from GET /api/runs/latest on load and
// resumes polling/approval through the existing poll()/decide() machinery -
// no new endpoint, no client storage of tokens/nonces, no second run.
//
// These tests execute the page's actual inline <script> in a Node vm
// sandbox with a minimal fake DOM and a scripted fetch, so the reattach
// logic is verified as real client behavior, not just a text pattern in the
// HTML source. A real browser reload is additionally verified manually
// (see docs/run-resume-reattach-r12.md).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const HTML_FILE = path.resolve("01_APP", "tests", "ai-router-v0_13-test.html");
const TEST_NONCE = "test-nonce-initial";

function extractInlineScript(html) {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "expected exactly one inline <script> in the v0.13 test UI");
  return match[1];
}

function makeElement() {
  return {
    textContent: "", className: "", value: "", disabled: false, hidden: false,
    colSpan: 0, onclick: null, onchange: null,
    appendChild(child) { return child; },
    append() {},
    addEventListener() {},
    querySelector() { return makeElement(); }
  };
}

function makeDocument() {
  const byId = new Map();
  return {
    getElementById(id) {
      if (!byId.has(id)) {
        const el = makeElement();
        // Mirrors the real markup: <section id="approval-panel" hidden> starts hidden.
        if (id === "approval-panel") el.hidden = true;
        byId.set(id, el);
      }
      return byId.get(id);
    },
    querySelector(selector) {
      if (typeof selector === "string" && selector.includes("approval-nonce")) return { content: TEST_NONCE };
      return makeElement();
    },
    createElement() { return makeElement(); }
  };
}

// Fast, deterministic timers: real setTimeout(fn, 0) regardless of the
// requested delay, so poll()'s 500ms recursion doesn't slow the suite down.
function fastSetTimeout(fn) { return setTimeout(fn, 0); }

async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

// Runs the page's real inline script in an isolated sandbox. `fetchImpl`
// stands in for the network; every call is recorded in `calls` so tests can
// assert on what was (and was not) requested. A small trailer exposes the
// script's top-level `let` state (activeRunId, pollTimer) for assertions -
// it does not alter any behavior, it only reads the same closures the real
// buttons/poll loop already read.
function runPage({ script, fetchImpl }) {
  const doc = makeDocument();
  const calls = [];
  const recordingFetch = async (url, options) => {
    calls.push({ url, method: options?.method || "GET", body: options?.body ? JSON.parse(options.body) : null });
    return fetchImpl(url, options);
  };
  const context = {
    document: doc,
    fetch: recordingFetch,
    setTimeout: fastSetTimeout,
    clearTimeout,
    console,
    URLSearchParams,
    Date,
    Object,
    Array,
    Number,
    Promise,
    isNaN,
    encodeURIComponent,
    decodeURIComponent
  };
  vm.createContext(context);
  const trailer = "\nvar __activeRunId=()=>activeRunId;\nvar __pollTimer=()=>pollTimer;\n";
  new vm.Script(script + trailer, { filename: "ai-router-v0_13-test.html<inline-script>" }).runInContext(context);
  return { doc, calls, context };
}

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

const awaitingApprovalRun = {
  schemaVersion: 1,
  runId: "run_awaiting_1",
  status: "awaiting_approval",
  routePlan: null,
  workflow: null,
  provider: null,
  approval: { required: true, status: "pending", requestedAt: "2026-08-23T10:00:00.000Z", decidedAt: null, decision: null, decisionNote: "", approvedAction: "", consumed: false },
  approvalContext: { plannedAction: "Datei löschen", whyApprovalRequired: "Irreversible Aktion", possibleConsequences: [], affectedSystems: [], affectedResources: [], reversibility: "nicht rückgängig", warnings: [] },
  providerSynthesis: null,
  result: null,
  error: null,
  warnings: [],
  timestamps: { createdAt: "2026-08-23T10:00:00.000Z", startedAt: null, finishedAt: "2026-08-23T10:00:00.000Z", updatedAt: "2026-08-23T10:00:00.000Z", durationMs: null },
  routerVersion: "0.13.0-test"
};

const terminalRun = {
  schemaVersion: 1,
  runId: "run_terminal_1",
  status: "succeeded",
  routePlan: null, workflow: null, provider: null, approval: null, approvalContext: null, providerSynthesis: null,
  result: { summary: "ok" }, error: null, warnings: [],
  timestamps: { createdAt: "2026-08-23T09:00:00.000Z", startedAt: "2026-08-23T09:00:00.000Z", finishedAt: "2026-08-23T09:05:00.000Z", updatedAt: "2026-08-23T09:05:00.000Z", durationMs: 300000 },
  routerVersion: "0.13.0-test"
};

const runningRun = {
  schemaVersion: 1,
  runId: "run_running_1",
  status: "running",
  routePlan: null, workflow: { type: "single_provider", status: "running", steps: [], currentStep: null }, provider: null, approval: null, approvalContext: null, providerSynthesis: null,
  result: null, error: null, warnings: [],
  timestamps: { createdAt: "2026-08-23T11:00:00.000Z", startedAt: "2026-08-23T11:00:00.000Z", finishedAt: null, updatedAt: "2026-08-23T11:00:00.000Z", durationMs: null },
  routerVersion: "0.13.0-test"
};

// Bootstrap fetches every page load makes regardless of reattach - stubbed
// identically across tests so only the reattach-relevant calls vary.
function baseFetchRouting(overrides) {
  return async (url) => {
    if (url === "/api/health") return jsonResponse({});
    if (url.startsWith("/api/history")) return jsonResponse({ runs: [] });
    if (url === "/api/providers") return jsonResponse({ providers: [] });
    const override = overrides.find((entry) => entry.match(url));
    if (override) return override.respond();
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
}

test.beforeEach(async (t) => {
  t.rawHtml = await fs.readFile(HTML_FILE, "utf8");
  t.script = extractInlineScript(t.rawHtml);
});

test("Test 1: an awaiting_approval run on the server is rediscovered and its approval panel is shown after a simulated reload", async (t) => {
  const fetchImpl = baseFetchRouting([
    { match: (u) => u === "/api/runs/latest", respond: () => jsonResponse(awaitingApprovalRun) },
    { match: (u) => u === `/api/runs/${awaitingApprovalRun.runId}`, respond: () => jsonResponse(awaitingApprovalRun) }
  ]);
  const { doc, context } = runPage({ script: t.script, fetchImpl });
  await flush();

  assert.equal(context.__activeRunId(), awaitingApprovalRun.runId, "activeRunId must be restored from the server's latest run, not left null after reload");
  assert.equal(doc.getElementById("approval-panel").hidden, false, "the approval panel must reappear for a still-pending run");
});

test("Test 2: reattach never creates a new run", async (t) => {
  const fetchImpl = baseFetchRouting([
    { match: (u) => u === "/api/runs/latest", respond: () => jsonResponse(awaitingApprovalRun) },
    { match: (u) => u === `/api/runs/${awaitingApprovalRun.runId}`, respond: () => jsonResponse(awaitingApprovalRun) }
  ]);
  const { calls } = runPage({ script: t.script, fetchImpl });
  await flush();

  const createCalls = calls.filter((c) => c.method === "POST" && c.url === "/api/runs");
  assert.equal(createCalls.length, 0, "resuming an existing run must never POST /api/runs");
});

test("Test 3: a terminal run is not falsely reattached as active", async (t) => {
  const fetchImpl = baseFetchRouting([
    { match: (u) => u === "/api/runs/latest", respond: () => jsonResponse(terminalRun) }
  ]);
  const { doc, context, calls } = runPage({ script: t.script, fetchImpl });
  await flush();

  assert.equal(context.__activeRunId(), null, "a succeeded/failed/cancelled/timed_out run must not become the active run after reload");
  assert.equal(doc.getElementById("approval-panel").hidden, true, "the approval panel must stay hidden for a terminal run");
  const pollCalls = calls.filter((c) => c.url === `/api/runs/${terminalRun.runId}`);
  assert.equal(pollCalls.length, 0, "a terminal run must not be polled");
});

test("Test 4: approve still works for a run reattached after reload", async (t) => {
  let served = { ...awaitingApprovalRun };
  const succeededRun = { ...awaitingApprovalRun, status: "succeeded", approval: { ...awaitingApprovalRun.approval, status: "approved", consumed: true }, result: { summary: "ok" }, timestamps: { ...awaitingApprovalRun.timestamps, finishedAt: "2026-08-23T10:01:00.000Z" } };
  const fetchImpl = baseFetchRouting([
    { match: (u) => u === "/api/runs/latest", respond: () => jsonResponse(served) },
    { match: (u) => u === `/api/runs/${awaitingApprovalRun.runId}`, respond: () => jsonResponse(served) },
    { match: (u) => u === `/api/runs/${awaitingApprovalRun.runId}/approval/ui`, respond: () => { served = succeededRun; return jsonResponse({ ...succeededRun, approvalNonce: "test-nonce-next" }); } }
  ]);
  const { doc, context, calls } = runPage({ script: t.script, fetchImpl });
  await flush();
  assert.equal(context.__activeRunId(), awaitingApprovalRun.runId, "precondition: run must be reattached first");

  const approveButton = doc.getElementById("approve");
  assert.equal(typeof approveButton.onclick, "function", "the approve button must have a click handler after reattach");
  approveButton.onclick();
  await flush();

  const decisionCalls = calls.filter((c) => c.url === `/api/runs/${awaitingApprovalRun.runId}/approval/ui`);
  assert.equal(decisionCalls.length, 1, "approving after reattach must reach the run-approval BFF exactly once");
  assert.equal(decisionCalls[0].body.decision, "approve");
  assert.equal(decisionCalls[0].body.nonce, TEST_NONCE, "the nonce read from the freshly served page must be used, not a stale one");
});

test("Test 5: reattaching a running run resumes polling exactly once, without a duplicate poll loop", async (t) => {
  let pollHits = 0;
  const fetchImpl = baseFetchRouting([
    { match: (u) => u === "/api/runs/latest", respond: () => jsonResponse(runningRun) },
    { match: (u) => u === `/api/runs/${runningRun.runId}`, respond: () => { pollHits += 1; return jsonResponse({ ...runningRun, status: "succeeded", timestamps: { ...runningRun.timestamps, finishedAt: "2026-08-23T11:01:00.000Z" }, result: { summary: "ok" } }); } }
  ]);
  const { context, calls } = runPage({ script: t.script, fetchImpl });
  await flush();

  assert.equal(pollHits, 1, "reattach must start exactly one poll cycle, not zero (lost run) and not two (duplicate polling)");
  const pollCalls = calls.filter((c) => c.url === `/api/runs/${runningRun.runId}`);
  assert.equal(pollCalls.length, 1, "no duplicate GET /api/runs/:id requests from overlapping poll loops");
  assert.equal(context.__pollTimer(), null, "poll must stop scheduling once the reattached run reaches a terminal status");
});
