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
