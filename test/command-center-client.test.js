import test from "node:test";
import assert from "node:assert/strict";
import { fetchCommandCenterStatus, COMMAND_CENTER_BASE_URL_ENV_VAR } from "../orchestrator/command-center-client.js";

const ENV = { [COMMAND_CENTER_BASE_URL_ENV_VAR]: "http://127.0.0.1:8765" };

function jsonResponse(body, { status = 200, contentType = "application/json" } = {}) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : name.toLowerCase() === "content-length" ? String(Buffer.byteLength(text)) : null) },
    text: async () => text
  };
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

test("unconfigured when the base URL env var is missing, never calls fetch", async () => {
  const result = await fetchCommandCenterStatus({ env: {}, fetchImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(result.state, "unconfigured");
  assert.equal(result.status, null);
});

test("success: passes the seven fields through unchanged, no token sent", async () => {
  let calledUrl, calledInit;
  const result = await fetchCommandCenterStatus({
    env: ENV,
    fetchImpl: async (url, init) => { calledUrl = url; calledInit = init; return jsonResponse(fullContract()); }
  });
  assert.equal(result.state, "ok");
  assert.equal(calledUrl, "http://127.0.0.1:8765/api/companion/status");
  assert.equal(calledInit.method, "GET");
  assert.equal(calledInit.headers.authorization, undefined);
  assert.deepEqual(Object.keys(result.status).sort(), [
    "activeWarningCount", "aiRouterOverallStatus", "generatedAt", "lastSuccessfulUpdate",
    "overallStatus", "schemaVersion", "statusFreshness"
  ]);
  assert.equal(result.status.overallStatus, "ok");
  assert.equal(result.status.activeWarningCount, 0);
});

test("rejects a payload with a missing required field (fail-closed, no partial rendering)", async () => {
  const incomplete = fullContract();
  delete incomplete.statusFreshness;
  const result = await fetchCommandCenterStatus({ env: ENV, fetchImpl: async () => jsonResponse(incomplete) });
  assert.equal(result.state, "unavailable");
  assert.equal(result.status, null);
});

test("rejects a payload with an unexpected extra field instead of ignoring it", async () => {
  const withExtra = fullContract({ activeProjectCount: 3 });
  const result = await fetchCommandCenterStatus({ env: ENV, fetchImpl: async () => jsonResponse(withExtra) });
  assert.equal(result.state, "unavailable");
});

test("rejects an unsupported schemaVersion", async () => {
  const result = await fetchCommandCenterStatus({ env: ENV, fetchImpl: async () => jsonResponse(fullContract({ schemaVersion: "2.0" })) });
  assert.equal(result.state, "unavailable");
});

for (const field of ["overallStatus", "aiRouterOverallStatus"]) {
  test(`rejects an invalid enum value for ${field}`, async () => {
    const result = await fetchCommandCenterStatus({ env: ENV, fetchImpl: async () => jsonResponse(fullContract({ [field]: "critical" })) });
    assert.equal(result.state, "unavailable");
  });
}

test("rejects an invalid statusFreshness value", async () => {
  const result = await fetchCommandCenterStatus({ env: ENV, fetchImpl: async () => jsonResponse(fullContract({ statusFreshness: "old" })) });
  assert.equal(result.state, "unavailable");
});

test("rejects a negative or non-integer activeWarningCount", async () => {
  const negative = await fetchCommandCenterStatus({ env: ENV, fetchImpl: async () => jsonResponse(fullContract({ activeWarningCount: -1 })) });
  assert.equal(negative.state, "unavailable");
  const fractional = await fetchCommandCenterStatus({ env: ENV, fetchImpl: async () => jsonResponse(fullContract({ activeWarningCount: 1.5 })) });
  assert.equal(fractional.state, "unavailable");
});

test("timeout yields unavailable, never throws", async () => {
  const result = await fetchCommandCenterStatus({
    env: ENV,
    timeoutMs: 5,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })
  });
  assert.equal(result.state, "unavailable");
});

test("a non-ok HTTP response yields unavailable", async () => {
  const result = await fetchCommandCenterStatus({
    env: ENV,
    fetchImpl: async () => ({ ok: false, headers: { get: () => null } })
  });
  assert.equal(result.state, "unavailable");
});

test("wrong content type is rejected fail-closed", async () => {
  const result = await fetchCommandCenterStatus({ env: ENV, fetchImpl: async () => jsonResponse(fullContract(), { contentType: "text/html" }) });
  assert.equal(result.state, "unavailable");
});

test("a body over the size cap is rejected fail-closed", async () => {
  const result = await fetchCommandCenterStatus({
    env: ENV,
    maxBodyBytes: 10,
    fetchImpl: async () => jsonResponse(fullContract())
  });
  assert.equal(result.state, "unavailable");
});
