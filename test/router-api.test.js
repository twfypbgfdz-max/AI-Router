import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ownsTemporaryDataDir = !process.env.AI_ROUTER_DATA_DIR;
if (ownsTemporaryDataDir) process.env.AI_ROUTER_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-api-tests-"));
const { createRouterServer } = await import("../orchestrator/server.js");
test.after(async () => {
  if (ownsTemporaryDataDir) await fs.rm(process.env.AI_ROUTER_DATA_DIR, { recursive: true, force: true });
});

async function withServer(run, options = {}) {
  const eventLogger = { log: async () => {} };
  const server = createRouterServer({ eventLogger, ...options });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
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

test("cockpit router status and actions endpoints expose safe contracts", async () => {
  await withServer(async (baseUrl) => {
    const statusResponse = await fetch(`${baseUrl}/api/router/status`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(statusResponse.status, 200);
    assert.equal(statusResponse.headers.get("access-control-allow-origin"), "http://localhost:3000");
    const status = await statusResponse.json();
    assert.equal(status.defaultMode, "simulate");
    assert.equal(status.executionEnabled, false);

    const actionsResponse = await fetch(`${baseUrl}/api/router/actions`);
    assert.equal(actionsResponse.status, 200);
    const actions = await actionsResponse.json();
    assert.equal(actions.actions.length, 6);
    assert.ok(actions.actions.every((action) => action.executionAllowed === false));
    assert.equal(JSON.stringify(actions).includes("C:\\"), false);
  });
});

test("router CORS uses an explicit allowlist and does not open existing APIs", async () => {
  await withServer(async (baseUrl) => {
    for (const origin of ["http://localhost:3001", "http://127.0.0.1:5173", "http://evil.localhost:3000", "https://example.com"]) {
      const response = await fetch(`${baseUrl}/api/router/status`, { headers: { Origin: origin } });
      assert.equal(response.status, 403, origin);
      assert.equal(response.headers.get("access-control-allow-origin"), null, origin);
      const payload = await response.json();
      assert.equal(payload.status, "error", origin);
      assert.equal(payload.error.code, "ORIGIN_NOT_ALLOWED", origin);
    }

    const existingGet = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(existingGet.status, 200);
    assert.equal(existingGet.headers.get("access-control-allow-origin"), null);

    const existingMutation = await fetch(`${baseUrl}/api/providers/select`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://localhost:3000" },
      body: "{}"
    });
    assert.equal(existingMutation.status, 403);
    assert.equal(existingMutation.headers.get("access-control-allow-origin"), null);

    const previousTrustedOrigin = await fetch(`${baseUrl}/api/providers/select`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://127.0.0.1:8787" },
      body: "{}"
    });
    assert.equal(previousTrustedOrigin.status, 200);
    assert.equal(previousTrustedOrigin.headers.get("access-control-allow-origin"), null);
  });
});

test("POST /api/router/route validates, routes and simulates without execution", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router/route`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://127.0.0.1:3000" },
      body: JSON.stringify({ schemaVersion: "1.0", source: "cockpit", input: { type: "text", content: "Zeige den Router-Status." } })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.route.name, "system_status");
    assert.equal(payload.decision.action, "router.status");
    assert.equal(payload.result.executed, false);
  });
});

test("POST /api/router/route blocks execute and malformed JSON with standard errors", async () => {
  await withServer(async (baseUrl) => {
    const executeResponse = await fetch(`${baseUrl}/api/router/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "1.0", source: "cockpit", mode: "execute", input: { type: "text", content: "Liste Aufgaben." } })
    });
    assert.equal(executeResponse.status, 403);
    assert.equal((await executeResponse.json()).error.code, "EXECUTION_DISABLED");

    const malformedResponse = await fetch(`${baseUrl}/api/router/route`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(malformedResponse.status, 400);
    const malformed = await malformedResponse.json();
    assert.equal(malformed.status, "error");
    assert.equal(malformed.error.code, "INVALID_REQUEST");
    assert.equal(malformed.result.executed, false);
  });
});

test("POST /api/router/route enforces the request body limit", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "1.0", source: "cockpit", input: { type: "text", content: "x".repeat(17_000) } })
    });
    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.equal(payload.error.code, "PAYLOAD_TOO_LARGE");
    assert.equal(payload.result.executed, false);
  });
});

test("unexpected router errors are generic, standardized and use HTTP 500", async () => {
  const routerProcessor = async () => { throw Object.assign(new Error("Failed at C:\\Users\\felil\\private.txt token=secret-value password=hunter2"), { stack: "private stack" }); };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "1.0", requestId: "req_internal", source: "cockpit", input: { type: "text", content: "Liste Aufgaben." } })
    });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.requestId, "req_internal");
    assert.equal(payload.error.code, "INTERNAL_ERROR");
    assert.equal(payload.error.message, "The router could not process the request.");
    for (const marker of ["C:\\", "secret-value", "hunter2", "private stack"]) assert.equal(JSON.stringify(payload).includes(marker), false, marker);
  }, { routerProcessor });
});

test("a real router timeout preserves request identity, duration and HTTP 504", async () => {
  const routerProcessor = () => new Promise(() => {});
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "1.0", requestId: "req_timeout", source: "cockpit", input: { type: "text", content: "Liste Aufgaben." } })
    });
    assert.equal(response.status, 504);
    assert.equal(response.headers.get("connection"), "close");
    const payload = await response.json();
    assert.equal(payload.requestId, "req_timeout");
    assert.equal(payload.error.code, "TIMEOUT");
    assert.ok(payload.meta.durationMs >= 20, payload.meta.durationMs);
    assert.deepEqual(Object.keys(payload), ["schemaVersion", "requestId", "status", "mode", "route", "decision", "result", "error", "meta"]);
  }, { routerProcessor, routerTimeoutMs: 25 });
});

test("slow request bodies are bounded by the router timeout", async () => {
  await withServer(async (baseUrl) => {
    const response = await slowJsonPost(`${baseUrl}/api/router/route`, '{"schemaVersion":"1.0",', '"source":"cockpit","input":{"type":"text","content":"Liste Aufgaben."}}', 80);
    assert.equal(response.status, 504);
    assert.equal(response.body.error.code, "TIMEOUT");
    assert.equal(response.body.requestId, null);
    assert.ok(response.body.meta.durationMs >= 20, response.body.meta.durationMs);
  }, { routerTimeoutMs: 25 });
});
