import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ownsTemporaryDataDir = !process.env.AI_ROUTER_DATA_DIR;
if (ownsTemporaryDataDir) process.env.AI_ROUTER_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-api-tests-"));
const { createRouterServer } = await import("../orchestrator/server.js");
test.after(async () => { if (ownsTemporaryDataDir) await fs.rm(process.env.AI_ROUTER_DATA_DIR, { recursive: true, force: true }); });

async function withServer(run, options = {}) {
  const server = createRouterServer({ eventLogger: { log: async () => {} }, ...options });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }); }
}

function requestBody(overrides = {}) {
  return { schemaVersion: "2.0", requestId: "req_api", source: "cockpit", mode: "recommendation", intent: "auto", input: { type: "text", content: "Zeige den Router-Status." }, ...overrides };
}

function slowJsonPost(url, firstChunk, finalChunk, delayMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method: "POST", headers: { "content-type": "application/json" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on("error", reject);
    request.write(firstChunk);
    setTimeout(() => { if (!request.destroyed) request.end(finalChunk); }, delayMs);
  });
}

test("router status and actions expose the closed v2 state model", async () => {
  await withServer(async (baseUrl) => {
    const statusResponse = await fetch(`${baseUrl}/api/router/status`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(statusResponse.status, 200);
    assert.equal(statusResponse.headers.get("access-control-allow-origin"), "http://localhost:3000");
    const status = await statusResponse.json();
    assert.equal(status.schemaVersion, "2.0");
    assert.equal(status.defaultMode, "recommendation");
    assert.deepEqual(status.activeModes, ["recommendation", "simulation"]);
    assert.equal(status.executionEnabled, false);
    const actions = await (await fetch(`${baseUrl}/api/router/actions`)).json();
    assert.ok(actions.actions.every((action) => action.executionAllowed === false));
    assert.equal(JSON.stringify(actions).includes("C:\\"), false);
  });
});

test("router CORS remains limited to the explicit local allowlist", async () => {
  await withServer(async (baseUrl) => {
    for (const origin of ["http://localhost:3001", "http://127.0.0.1:5173", "http://evil.localhost:3000", "https://example.com"]) {
      const response = await fetch(`${baseUrl}/api/router/status`, { headers: { Origin: origin } });
      assert.equal(response.status, 403, origin);
      const payload = await response.json();
      assert.equal(payload.status, "failed", origin);
      assert.equal(payload.error.code, "ORIGIN_NOT_ALLOWED", origin);
    }
    const existing = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(existing.status, 200);
    assert.equal(existing.headers.get("access-control-allow-origin"), null);
  });
});

test("POST /api/router/route returns recommendation and simulation in one Cockpit-ready schema", async () => {
  await withServer(async (baseUrl) => {
    const recommendationResponse = await fetch(`${baseUrl}/api/router/route`, { method: "POST", headers: { "content-type": "application/json", Origin: "http://127.0.0.1:3000" }, body: JSON.stringify(requestBody()) });
    assert.equal(recommendationResponse.status, 200);
    const recommendation = await recommendationResponse.json();
    assert.equal(recommendation.status, "recommended");
    assert.equal(recommendation.recommendation.route, "system_status");
    assert.equal(recommendation.simulation, null);
    assert.equal(recommendation.meta.executionEnabled, false);

    const simulationResponse = await fetch(`${baseUrl}/api/router/route`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody({ mode: "simulation" })) });
    assert.equal(simulationResponse.status, 200);
    const simulation = await simulationResponse.json();
    assert.equal(simulation.status, "simulated");
    assert.equal(simulation.simulation.providerId, "mock-local");
    assert.equal(simulation.simulation.executed, false);
    assert.equal(simulation.blockedActions.includes("shell.run"), true);
  });
});

test("the current Cockpit v1 simulation maps through the central core without parallel routing", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router/route`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, mode: "simulate", execute: false, type: "route.recommendation", request: "Cockpit-Projektstatus zusammenfassen", requestedCapability: "simulate" })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(Object.keys(payload), ["schemaVersion", "mode", "label", "request", "intent", "route", "target", "reason", "risk", "proposedAction", "executionStatus", "executed", "generatedAt"]);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.mode, "simulate");
    assert.equal(payload.intent, "project_status_summary");
    assert.equal(payload.route, "codex");
    assert.equal(payload.executed, false);
    assert.equal(payload.executionStatus, "never_executed");
  });
});

test("invalid modes, legacy execution attempts and malformed JSON fail safely", async () => {
  await withServer(async (baseUrl) => {
    const execution = await fetch(`${baseUrl}/api/router/route`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody({ mode: "execution" })) });
    assert.equal(execution.status, 422);
    assert.equal((await execution.json()).error.code, "MODE_NOT_ALLOWED");
    const legacyExecution = await fetch(`${baseUrl}/api/router/route`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, mode: "simulate", execute: true, type: "route.recommendation", request: "Status", requestedCapability: "simulate" }) });
    assert.equal(legacyExecution.status, 422);
    assert.equal((await legacyExecution.json()).error.code, "MODE_NOT_ALLOWED");
    const malformed = await fetch(`${baseUrl}/api/router/route`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(malformed.status, 400);
    const payload = await malformed.json();
    assert.equal(payload.status, "failed");
    assert.equal(payload.error.code, "INVALID_REQUEST");
  });
});

test("POST /api/router/route enforces the body limit", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router/route`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody({ input: { type: "text", content: "x".repeat(17_000) } })) });
    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.equal(payload.error.code, "PAYLOAD_TOO_LARGE");
    assert.equal(payload.simulation, null);
  });
});

test("unexpected errors are generic and never expose private details", async () => {
  const routerProcessor = async () => { throw Object.assign(new Error("Failed at C:\\Users\\felil\\private.txt token=secret-value password=hunter2"), { stack: "private stack" }); };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router/route`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody({ requestId: "req_internal" })) });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.requestId, "req_internal");
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    for (const marker of ["C:\\", "secret-value", "hunter2", "private stack"]) assert.equal(JSON.stringify(payload).includes(marker), false);
  }, { routerProcessor });
});

test("router timeout preserves request identity and the v2 error envelope", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router/route`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody({ requestId: "req_timeout" })) });
    assert.equal(response.status, 504);
    const payload = await response.json();
    assert.equal(payload.requestId, "req_timeout");
    assert.equal(payload.error.code, "TIMEOUT");
    assert.ok(payload.meta.durationMs >= 20);
    assert.deepEqual(Object.keys(payload), ["schemaVersion", "requestId", "routerVersion", "status", "mode", "recommendation", "simulation", "risks", "constraints", "allowedNextSteps", "blockedActions", "error", "meta"]);
  }, { routerProcessor: () => new Promise(() => {}), routerTimeoutMs: 25 });
});

test("slow request bodies are bounded by the router timeout", async () => {
  await withServer(async (baseUrl) => {
    const response = await slowJsonPost(`${baseUrl}/api/router/route`, '{"schemaVersion":"2.0",', '"source":"cockpit","mode":"recommendation","intent":"auto","input":{"type":"text","content":"Status"}}', 80);
    assert.equal(response.status, 504);
    assert.equal(response.body.error.code, "TIMEOUT");
    assert.equal(response.body.status, "failed");
  }, { routerTimeoutMs: 25 });
});
