import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ownsTemporaryDataDir = !process.env.AI_ROUTER_DATA_DIR;
if (ownsTemporaryDataDir) process.env.AI_ROUTER_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-jarvis-today-tests-"));
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

test("GET /api/jarvis/today responds 200 with {schemaVersion, cockpitState, context}, fail-closed by default (no Cockpit env in tests)", async () => {
  await withServer(async (baseUrl) => {
    const { status, headers, body } = await get(baseUrl, "/api/jarvis/today");
    assert.equal(status, 200);
    assert.match(headers["content-type"], /application\/json/);
    assert.deepEqual(Object.keys(body).sort(), ["cockpitState", "context", "schemaVersion"]);
    assert.equal(body.schemaVersion, "1.0");
    assert.ok(["ok", "unavailable", "unconfigured"].includes(body.cockpitState));
    // No AI_ROUTER_COCKPIT_BASE_URL/READ_TOKEN set for this process -
    // deterministically "unconfigured", not a guess.
    assert.equal(body.cockpitState, "unconfigured");
    assert.equal(body.context, null);
  });
});

test("GET /api/jarvis/today requires no Authorization header - same trust level as /api/jarvis/ready", async () => {
  await withServer(async (baseUrl) => {
    const { status } = await get(baseUrl, "/api/jarvis/today");
    assert.equal(status, 200);
  });
});

test("an unsupported method on the route falls through to the router's normal 404, not a crash", async () => {
  await withServer(async (baseUrl) => {
    const response = await new Promise((resolve, reject) => {
      const target = new URL("/api/jarvis/today", baseUrl);
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

test("GET /api/jarvis/today never leaks a token, path or URL in its response body", async () => {
  await withServer(async (baseUrl) => {
    const { body } = await get(baseUrl, "/api/jarvis/today");
    const serialized = JSON.stringify(body);
    assert.ok(!/[A-Za-z]:\\/.test(serialized));
    assert.ok(!/https?:\/\//.test(serialized));
  });
});
