import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ownsTemporaryDataDir = !process.env.AI_ROUTER_DATA_DIR;
if (ownsTemporaryDataDir) process.env.AI_ROUTER_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-jarvis-run-tests-"));
const { createRouterServer } = await import("../orchestrator/server.js");
const { RunService } = await import("../orchestrator/run-service.js");
const { sessionStore } = await import("../orchestrator/session/session-store.js");
test.after(async () => { if (ownsTemporaryDataDir) await fs.rm(process.env.AI_ROUTER_DATA_DIR, { recursive: true, force: true }); });

const GIT_STATE = { repository: "C:\\Users\\felil\\Documents\\KI\\AI-Router", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" };

function fakeRunService() {
  return new RunService({
    adapter: {
      resolveCodexExecutable: async () => "codex",
      runCodex: async () => ({ exitCode: 0, issues: [], stderr: "", events: [{ text: "ok" }], resultSummary: "AI-Router looks fine." })
    },
    git: { captureGitState: async () => GIT_STATE, compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {},
    publish: async () => {}
  });
}

async function withServer(run, { service } = {}) {
  const server = createRouterServer({ eventLogger: { log: async () => {} }, service: service || fakeRunService() });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }); }
}

function post(url, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, url);
    const payload = JSON.stringify(body);
    const request = http.request(target, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers } }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(responseBody) }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function get(url, pathname) {
  return new Promise((resolve, reject) => {
    http.get(new URL(pathname, url), (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    }).on("error", reject);
  });
}

test("POST /api/jarvis/run dispatches a real codex-cli run, visible via GET /api/runs/:id", async () => {
  await withServer(async (baseUrl) => {
    const { status, body } = await post(baseUrl, "/api/jarvis/run", { question: "Prüf den AI-Router." });
    assert.equal(status, 202);
    assert.equal(body.plan.taskClass, "code_analysis");
    assert.equal(body.plan.mode, "read_only");
    assert.ok(!("prompt" in body.plan));
    assert.equal(body.run.adapter, "codex-cli");
    assert.ok(body.run.runId);

    for (let i = 0; i < 50; i += 1) {
      const detail = await get(baseUrl, `/api/runs/${body.run.runId}`);
      if (["succeeded", "failed"].includes(detail.body.status)) {
        assert.equal(detail.body.status, "succeeded");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
});

test("POST /api/jarvis/run correlates sessionId with the run via the existing run endpoints", async () => {
  await withServer(async (baseUrl) => {
    const { status, body } = await post(baseUrl, "/api/jarvis/run", { question: "Prüf den AI-Router.", sessionId: "abc-123" });
    assert.equal(status, 202);
    assert.equal(body.run.sessionId, "abc-123");
    const detail = await get(baseUrl, `/api/runs/${body.run.runId}`);
    assert.equal(detail.body.sessionId, "abc-123");
  });
});

test("POST /api/jarvis/run fails closed (422) for a code_implementation request, no run created", async () => {
  await withServer(async (baseUrl) => {
    const { status, body } = await post(baseUrl, "/api/jarvis/run", { question: "Beheb den Fehler im AI-Router." });
    assert.equal(status, 422);
    assert.equal(body.plan.taskClass, "code_implementation");
    assert.equal(body.error.code, "EXECUTION_DISABLED");
  });
});

test("POST /api/jarvis/run fails closed (422) for an unresolved project", async () => {
  await withServer(async (baseUrl) => {
    const { status, body } = await post(baseUrl, "/api/jarvis/run", { question: "Prüf das Projekt Foobar." });
    assert.equal(status, 422);
    assert.equal(body.plan.project.status, "unknown");
  });
});

test("POST /api/jarvis/run rejects an untrusted (cross-origin) request", async () => {
  await withServer(async (baseUrl) => {
    const { status } = await post(baseUrl, "/api/jarvis/run", { question: "Prüf den AI-Router." }, { origin: "https://evil.example" });
    assert.equal(status, 403);
  });
});

test("GET /api/jarvis/run is not a route (falls through to 404, not a crash)", async () => {
  await withServer(async (baseUrl) => {
    const { status } = await get(baseUrl, "/api/jarvis/run");
    assert.equal(status, 404);
  });
});

// J1.3 Phase 4/5 - Result Ingestion / Rückkanal. GET /api/jarvis/run/:runId
// reuses the SAME live RunService the POST route just dispatched to - no new
// result store - and returns the bounded, Jarvis-consumable projection.
test("GET /api/jarvis/run/:runId returns the safe result once the real run has succeeded", async () => {
  await withServer(async (baseUrl) => {
    const dispatched = await post(baseUrl, "/api/jarvis/run", { question: "Prüf den AI-Router.", sessionId: "res-abc" });
    assert.equal(dispatched.status, 202);
    const runId = dispatched.body.run.runId;

    let final;
    for (let i = 0; i < 50; i += 1) {
      const { body } = await get(baseUrl, `/api/jarvis/run/${runId}`);
      if (body.result?.status === "succeeded") { final = body.result; break; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(final, "run did not reach succeeded in time");
    assert.equal(final.runId, runId);
    assert.equal(final.status, "succeeded");
    assert.equal(final.sessionId, "res-abc");
    assert.equal(final.resultAvailable, true);
    assert.equal(final.summary, "AI-Router looks fine.");
    assert.deepEqual(final.project, { id: "ai-router", name: "AI-Router" });
    assert.ok(!/[A-Za-z]:\\/.test(JSON.stringify(final)), "no local path in the Jarvis result");
  });
});

// 6. 2026-08-30 real codex-cli smoke test finding: a genuine analysis result
// quoted absolute local paths (e.g. a markdown file reference), and the
// existing "no local path" check above never actually exercised that case
// (the fake adapter's resultSummary never contained one). This uses a
// dedicated fake service whose resultSummary/warnings mirror exactly that
// leaked shape, end-to-end over the real HTTP route.
function fakeRunServiceWithPathInResult() {
  return new RunService({
    adapter: {
      resolveCodexExecutable: async () => "codex",
      runCodex: async () => ({
        exitCode: 0,
        issues: [],
        stderr: "",
        events: [{ text: "ok" }],
        resultSummary: "Siehe [run-dispatcher.js](C:/Users/felil/Documents/KI/AI-Router/orchestrator/jarvis/run-dispatcher.js:169) und C:\\Users\\felil\\Documents\\KI\\AI-Router\\orchestrator\\run-service.js fuer Details."
      })
    },
    git: { captureGitState: async () => GIT_STATE, compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {},
    publish: async () => {}
  });
}

test("6. GET /api/jarvis/run/:runId never carries an absolute local path, even when the real result quotes one", async () => {
  await withServer(async (baseUrl) => {
    const dispatched = await post(baseUrl, "/api/jarvis/run", { question: "Prüf den AI-Router.", sessionId: "res-path" });
    assert.equal(dispatched.status, 202);
    const runId = dispatched.body.run.runId;

    let final;
    for (let i = 0; i < 50; i += 1) {
      const { body } = await get(baseUrl, `/api/jarvis/run/${runId}`);
      if (body.result?.status === "succeeded") { final = body.result; break; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(final, "run did not reach succeeded in time");
    assert.ok(final.summary.includes("[local-path]"), "the leaked path must have been redacted, not silently dropped");
    assert.ok(!/[A-Za-z]:[\\/]/.test(JSON.stringify(final)), "no absolute local path anywhere in the public Jarvis result");
  }, { service: fakeRunServiceWithPathInResult() });
});

test("GET /api/jarvis/run/:runId returns result: null for an unknown runId, not an error", async () => {
  await withServer(async (baseUrl) => {
    const { status, body } = await get(baseUrl, "/api/jarvis/run/does-not-exist");
    assert.equal(status, 200);
    assert.equal(body.result, null);
  });
});

test("GET /api/jarvis/run/:runId requires no origin/token - same read-only trust level as other GET /api/jarvis/* routes", async () => {
  await withServer(async (baseUrl) => {
    const dispatched = await post(baseUrl, "/api/jarvis/run", { question: "Prüf den AI-Router." });
    const { status } = await get(baseUrl, `/api/jarvis/run/${dispatched.body.run.runId}`);
    assert.equal(status, 200);
  });
});

// J1.3 Phase 6 - a bounded "run started" session turn is written, never the
// eventual result (not known yet at dispatch time) and never raw output.
test("a successful dispatch appends one bounded 'run started' turn to the session, not the raw run output", async () => {
  await withServer(async (baseUrl) => {
    const sessionId = `sess-turn-${Date.now()}`;
    const { body } = await post(baseUrl, "/api/jarvis/run", { question: "Prüf den AI-Router.", sessionId });
    const session = sessionStore.getSession(sessionId);
    assert.ok(session, "session must exist after a sessionId-carrying dispatch");
    assert.equal(session.turns.length, 1);
    assert.equal(session.turns[0].question, "Prüf den AI-Router.");
    assert.ok(session.turns[0].answer.includes(body.run.runId));
    assert.ok(session.turns[0].answer.length < 500, "the turn must stay a short, bounded status note, not raw agent output");
  });
});

// Separate servers per case (RunService only permits one active run at a
// time - sequential dispatches on the same service would race).
test("POST /api/jarvis/run's own same-origin trust check matches POST /api/runs's isTrustedMutation: no Origin is accepted", async () => {
  await withServer(async (baseUrl) => {
    const { status } = await post(baseUrl, "/api/jarvis/run", { question: "Prüf den AI-Router." });
    assert.equal(status, 202, "no Origin header is accepted, matching every other local mutation route (isTrustedMutation)");
  });
});

test("POST /api/jarvis/run's trust check accepts the same trusted local origin as every other route", async () => {
  await withServer(async (baseUrl) => {
    const { status } = await post(baseUrl, "/api/jarvis/run", { question: "Prüf den AI-Router." }, { origin: "http://localhost:8787" });
    assert.equal(status, 202);
  });
});
