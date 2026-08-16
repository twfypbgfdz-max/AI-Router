import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ownsTemporaryDataDir = !process.env.AI_ROUTER_DATA_DIR;
if (ownsTemporaryDataDir) process.env.AI_ROUTER_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-jarvis-system-tests-"));
const { createRouterServer } = await import("../orchestrator/server.js");
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

test("GET /api/jarvis/system responds 200 with {schemaVersion, commandCenterState, status}, fail-closed by default (no Command Center env in tests)", async () => {
  await withServer(async (baseUrl) => {
    const { status, headers, body } = await get(baseUrl, "/api/jarvis/system");
    assert.equal(status, 200);
    assert.match(headers["content-type"], /application\/json/);
    assert.deepEqual(Object.keys(body).sort(), ["commandCenterState", "schemaVersion", "status"]);
    assert.equal(body.schemaVersion, "1.0");
    // No AI_ROUTER_COMMAND_CENTER_BASE_URL set for this process -
    // deterministically "unconfigured", not a guess.
    assert.equal(body.commandCenterState, "unconfigured");
    assert.equal(body.status, null);
  });
});

test("GET /api/jarvis/system requires no Authorization header - same trust level as /api/jarvis/today", async () => {
  await withServer(async (baseUrl) => {
    const { status } = await get(baseUrl, "/api/jarvis/system");
    assert.equal(status, 200);
  });
});

test("an unsupported method on the route falls through to the router's normal 404, not a crash", async () => {
  await withServer(async (baseUrl) => {
    const response = await new Promise((resolve, reject) => {
      const target = new URL("/api/jarvis/system", baseUrl);
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

test("GET /api/jarvis/system never leaks a token, path or URL in its response body", async () => {
  await withServer(async (baseUrl) => {
    const { body } = await get(baseUrl, "/api/jarvis/system");
    const serialized = JSON.stringify(body);
    assert.ok(!/[A-Za-z]:\\/.test(serialized));
    assert.ok(!/https?:\/\//.test(serialized));
  });
});
