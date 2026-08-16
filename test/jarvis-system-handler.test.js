import test from "node:test";
import assert from "node:assert/strict";
import { createJarvisSystemHandler } from "../orchestrator/jarvis-system-handler.js";
import { COMMAND_CENTER_BASE_URL_ENV_VAR } from "../orchestrator/command-center-client.js";

const ENV = { [COMMAND_CENTER_BASE_URL_ENV_VAR]: "http://127.0.0.1:8765" };

function response() {
  const res = new (class extends Object {})();
  res.headers = new Map();
  res.statusCode = 200;
  res.body = "";
  res.setHeader = (n, v) => res.headers.set(String(n).toLowerCase(), String(v));
  res.getHeader = (n) => res.headers.get(String(n).toLowerCase());
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    return res;
  };
  res.end = (v = "") => { res.body = String(v); };
  res.json = () => JSON.parse(res.body);
  return res;
}

function jsonFetch(payload, { ok = true } = {}) {
  return async () => ({
    ok,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify(payload)
  });
}

function fullContract(overrides = {}) {
  return {
    schemaVersion: "1.0",
    generatedAt: "2026-08-16T08:00:00.000Z",
    overallStatus: "ok",
    aiRouterOverallStatus: "ok",
    activeWarningCount: 0,
    lastSuccessfulUpdate: "2026-08-16T07:55:00.000Z",
    statusFreshness: "fresh",
    ...overrides
  };
}

// --- fail-closed behaviour -----------------------------------------------

test("GET /api/jarvis/system reports commandCenterState 'unconfigured' and status null when the env is not set, never throws", async () => {
  const handler = createJarvisSystemHandler({ env: {}, fetchImpl: async () => { throw new Error("must not be called"); } });
  const res = response();
  await handler({}, res);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schemaVersion, "1.0");
  assert.equal(body.commandCenterState, "unconfigured");
  assert.equal(body.status, null);
});

test("reports commandCenterState 'unavailable' and status null when Command Center cannot be reached", async () => {
  const handler = createJarvisSystemHandler({ env: ENV, fetchImpl: async () => { throw new Error("network down"); } });
  const res = response();
  await handler({}, res);
  const body = res.json();
  assert.equal(body.commandCenterState, "unavailable");
  assert.equal(body.status, null);
});

test("reports 'unavailable' (not a thrown error) when Command Center's own contract validation would fail (missing field)", async () => {
  const incomplete = fullContract();
  delete incomplete.activeWarningCount;
  const handler = createJarvisSystemHandler({ env: ENV, fetchImpl: jsonFetch(incomplete) });
  const res = response();
  await handler({}, res);
  assert.equal(res.json().commandCenterState, "unavailable");
});

// --- reuse of the exact contract, no own status logic ----------------------

test("passes the seven companion-contract fields through unchanged, nothing added, nothing derived", async () => {
  const handler = createJarvisSystemHandler({
    env: ENV,
    fetchImpl: jsonFetch(fullContract({ overallStatus: "warning", activeWarningCount: 2, statusFreshness: "stale" }))
  });
  const res = response();
  await handler({}, res);
  const body = res.json();
  assert.equal(body.commandCenterState, "ok");
  assert.deepEqual(body.status, fullContract({ overallStatus: "warning", activeWarningCount: 2, statusFreshness: "stale" }));
});

// --- no write path, no new data source -------------------------------------

test("never sends anything but a GET-shaped read to Command Center - no body, no Authorization header", async () => {
  let seenInit = null;
  const handler = createJarvisSystemHandler({
    env: ENV,
    fetchImpl: async (_url, init) => {
      seenInit = init;
      return { ok: true, headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) }, text: async () => JSON.stringify(fullContract()) };
    }
  });
  await handler({}, response());
  assert.equal(seenInit.method, "GET");
  assert.equal(seenInit.body, undefined);
  assert.equal(seenInit.headers.authorization, undefined);
});

test("response body contains no path, no URL, no secret-looking value", async () => {
  const handler = createJarvisSystemHandler({ env: ENV, fetchImpl: jsonFetch(fullContract()) });
  const res = response();
  await handler({}, res);
  assert.ok(!/[A-Za-z]:\\/.test(res.body));
  assert.ok(!/https?:\/\//.test(res.body));
});
