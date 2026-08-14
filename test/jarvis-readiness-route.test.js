import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ownsTemporaryDataDir = !process.env.AI_ROUTER_DATA_DIR;
if (ownsTemporaryDataDir) process.env.AI_ROUTER_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-jarvis-ready-tests-"));
const { createRouterServer, attachServerErrorHandler } = await import("../orchestrator/server.js");
test.after(async () => { if (ownsTemporaryDataDir) await fs.rm(process.env.AI_ROUTER_DATA_DIR, { recursive: true, force: true }); });

async function withServer(run) {
  const server = createRouterServer({ eventLogger: { log: async () => {} } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }); }
}

function get(url, pathname) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, url);
    http.get(target, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) }));
    }).on("error", reject);
  });
}

test("GET /api/jarvis/ready responds 200 with the closed {state, coreReady, voiceReady, reasons} shape", async () => {
  await withServer(async (baseUrl) => {
    const { status, headers, body } = await get(baseUrl, "/api/jarvis/ready");
    assert.equal(status, 200);
    assert.match(headers["content-type"], /application\/json/);
    assert.deepEqual(Object.keys(body).sort(), ["coreReady", "reasons", "state", "voiceReady"]);
    assert.ok(["ready", "partial", "unavailable"].includes(body.state));
    assert.equal(typeof body.coreReady, "boolean");
    assert.equal(typeof body.voiceReady, "boolean");
    assert.ok(Array.isArray(body.reasons));
  });
});

test("GET /api/jarvis/ready requires no Authorization header - same trust level as /api/health", async () => {
  await withServer(async (baseUrl) => {
    const { status } = await get(baseUrl, "/api/jarvis/ready");
    assert.equal(status, 200);
  });
});

test("GET /api/jarvis/ready never leaks a token, path or URL in its response body", async () => {
  await withServer(async (baseUrl) => {
    const { body } = await get(baseUrl, "/api/jarvis/ready");
    const serialized = JSON.stringify(body);
    assert.ok(!/[A-Za-z]:\\/.test(serialized));
    assert.ok(!/https?:\/\//.test(serialized));
  });
});

test("an unsupported method on the route falls through to the router's normal 404, not a crash", async () => {
  await withServer(async (baseUrl) => {
    const response = await new Promise((resolve, reject) => {
      const target = new URL("/api/jarvis/ready", baseUrl);
      const request = http.request(target, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(response.status, 404);
  });
});

// --- EADDRINUSE handling --------------------------------------------------

test("attachServerErrorHandler turns EADDRINUSE into a clear message and a single exit(1), never an unhandled exception", async () => {
  const busyServer = net.createServer();
  await new Promise((resolve) => busyServer.listen(0, "127.0.0.1", resolve));
  const { port } = busyServer.address();

  try {
    const router = createRouterServer({ eventLogger: { log: async () => {} } });
    const logs = [];
    const exits = [];
    attachServerErrorHandler(router, {
      port,
      host: "127.0.0.1",
      logFn: (message) => logs.push(message),
      exit: (code) => exits.push(code)
    });

    await new Promise((resolve) => {
      router.once("error", () => resolve());
      router.listen(port, "127.0.0.1");
    });

    assert.equal(exits.length, 1);
    assert.equal(exits[0], 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /already in use/i);
    assert.match(logs[0], new RegExp(String(port)));
  } finally {
    await new Promise((resolve) => busyServer.close(resolve));
  }
});

test("attachServerErrorHandler handles a non-EADDRINUSE server error with a distinct message and still exits cleanly", () => {
  const server = { on(event, handler) { this.handler = handler; } };
  const logs = [];
  const exits = [];
  attachServerErrorHandler(server, { port: 8787, host: "127.0.0.1", logFn: (m) => logs.push(m), exit: (c) => exits.push(c) });
  server.handler(new Error("something else"));
  assert.equal(exits[0], 1);
  assert.match(logs[0], /server error/i);
  assert.ok(!/already in use/i.test(logs[0]));
});
