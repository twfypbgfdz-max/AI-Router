import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ownsTemporaryDataDir = !process.env.AI_ROUTER_DATA_DIR;
if (ownsTemporaryDataDir) process.env.AI_ROUTER_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-jarvis-session-summary-tests-"));
const { createRouterServer } = await import("../orchestrator/server.js");
test.after(async () => { if (ownsTemporaryDataDir) await fs.rm(process.env.AI_ROUTER_DATA_DIR, { recursive: true, force: true }); });

async function withServer(run) {
  const server = createRouterServer({ eventLogger: { log: async () => {} } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }); }
}

function post(url, pathname, body, { origin } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, url);
    const payload = JSON.stringify(body);
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(payload) };
    if (origin) headers.origin = origin;
    const request = http.request(target, { method: "POST", headers }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: raw ? JSON.parse(raw) : null }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

test("POST /api/jarvis/session/summary with no sessionId responds 200 with {schemaVersion, summary: null}", async () => {
  await withServer(async (baseUrl) => {
    const { status, headers, body } = await post(baseUrl, "/api/jarvis/session/summary", {});
    assert.equal(status, 200);
    assert.match(headers["content-type"], /application\/json/);
    assert.deepEqual(Object.keys(body).sort(), ["schemaVersion", "summary"]);
    assert.equal(body.schemaVersion, "1.0");
    assert.equal(body.summary, null);
  });
});

test("POST /api/jarvis/session/summary requires no Authorization header (same trust level as /api/jarvis/ask)", async () => {
  await withServer(async (baseUrl) => {
    const { status } = await post(baseUrl, "/api/jarvis/session/summary", {});
    assert.equal(status, 200);
  });
});

test("an untrusted cross-origin request is rejected with 403, matching /api/jarvis/ask's gate", async () => {
  await withServer(async (baseUrl) => {
    const { status, body } = await post(baseUrl, "/api/jarvis/session/summary", {}, { origin: "https://evil.example" });
    assert.equal(status, 403);
    assert.equal(body.code, "INVALID_REQUEST");
  });
});

test("a GET on the route falls through to the router's normal 404, not a crash", async () => {
  await withServer(async (baseUrl) => {
    const response = await new Promise((resolve, reject) => {
      http.get(new URL("/api/jarvis/session/summary", baseUrl), (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", reject);
    });
    assert.equal(response.status, 404);
  });
});
