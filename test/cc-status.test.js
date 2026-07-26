import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCcStatusHandler } from "../orchestrator/cc-status-handler.js";
import { buildCcStatusData } from "../orchestrator/cc-status-service.js";
import { fakeHttpExchange } from "./text-response-helpers.js";

const TEST_CC_TOKEN = "test-cc-service-token-0123456789abcdef";

function ccEnv(overrides = {}) {
  return { AI_ROUTER_CC_TOKEN: TEST_CC_TOKEN, ...overrides };
}

function ccExchange({ method = "GET", headers, ...rest } = {}) {
  return fakeHttpExchange({
    method,
    headers: headers ?? { authorization: `Bearer ${TEST_CC_TOKEN}` },
    ...rest
  });
}

function fakeRegistry({
  registryStatus = "ok",
  providerStatuses = [
    { providerId: "mock-local", status: "available", simulated: true, executable: true, checkedAt: null }
  ]
} = {}) {
  return { status: () => ({ registryStatus, providerStatuses }) };
}

function handlerWith({ env = ccEnv(), registry, logEntries = [], timingSafeEqualFn, wallClock, buildStatusData, timeoutMs, setTimer, clearTimer } = {}) {
  return {
    handler: createCcStatusHandler({
      env,
      registry,
      buildStatusData,
      timingSafeEqualFn,
      wallClock,
      timeoutMs,
      setTimer,
      clearTimer,
      eventLogger: { log: async (entry) => { logEntries.push(entry); } }
    }),
    logEntries
  };
}

test("1. valid success response has the exact required shape and no top-level status field", async () => {
  const { handler } = handlerWith({ registry: fakeRegistry() });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 200);
  const body = exchange.response.json();
  assert.deepEqual(Object.keys(body).sort(), ["activeModes", "error", "generatedAt", "providers", "routerStatus", "routerVersion", "schemaVersion", "usage"].sort());
  assert.equal(body.schemaVersion, "1.0");
  assert.equal(body.error, null);
  assert.ok(Number.isFinite(Date.parse(body.generatedAt)));
  assert.deepEqual(body.activeModes, ["recommendation", "simulation"]);
});

test("2. full provider projection carries only the five allowlisted fields per provider", async () => {
  const { handler } = handlerWith({
    registry: fakeRegistry({
      providerStatuses: [
        { providerId: "mock-local", status: "available", simulated: true, executable: true, checkedAt: null, extraneous: "drop-me" },
        { providerId: "claude-simulated", status: "available", simulated: true, executable: false, checkedAt: null }
      ]
    })
  });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  const body = exchange.response.json();
  assert.equal(body.providers.length, 2);
  for (const provider of body.providers) {
    assert.deepEqual(Object.keys(provider).sort(), ["checkedAt", "executable", "providerId", "simulated", "status"].sort());
  }
  assert.equal(body.providers[0].providerId, "mock-local");
  assert.equal("extraneous" in body.providers[0], false);
});

test("3. routerStatus is ok when the provider registry is fully valid", async () => {
  const { handler } = handlerWith({ registry: fakeRegistry({ registryStatus: "ok" }) });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.json().routerStatus, "ok");
});

test("4. routerStatus is degraded when the provider registry has invalid entries", async () => {
  const { handler } = handlerWith({ registry: fakeRegistry({ registryStatus: "degraded" }) });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.json().routerStatus, "degraded");
});

test("5a. every allowlisted provider status value round-trips unchanged, including invalid", async () => {
  const { handler } = handlerWith({
    registry: fakeRegistry({
      providerStatuses: [
        { providerId: "p-available", status: "available", simulated: true, executable: true, checkedAt: null },
        { providerId: "p-unavailable", status: "unavailable", simulated: true, executable: false, checkedAt: null },
        { providerId: "p-unknown", status: "unknown", simulated: true, executable: false, checkedAt: null },
        { providerId: "p-invalid", status: "invalid", simulated: true, executable: false, checkedAt: null }
      ]
    })
  });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  const statuses = Object.fromEntries(exchange.response.json().providers.map((p) => [p.providerId, p.status]));
  assert.equal(statuses["p-available"], "available");
  assert.equal(statuses["p-unavailable"], "unavailable");
  assert.equal(statuses["p-unknown"], "unknown");
  // "invalid" is a real, allowlisted registry status (a broken provider entry)
  // and must be passed through unchanged, not downgraded.
  assert.equal(statuses["p-invalid"], "invalid");
});

test("5b. a non-allowlisted status value (e.g. a per-provider 'degraded') is coerced to unknown, never passed through", async () => {
  const { handler } = handlerWith({
    registry: fakeRegistry({
      providerStatuses: [
        { providerId: "p-bogus", status: "degraded", simulated: true, executable: false, checkedAt: null }
      ]
    })
  });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  const statuses = Object.fromEntries(exchange.response.json().providers.map((p) => [p.providerId, p.status]));
  // "degraded" is never a valid per-provider value; it must be coerced, not passed through.
  assert.equal(statuses["p-bogus"], "unknown");
});

test("6. checkedAt is present and null for every provider", async () => {
  const { handler } = handlerWith({ registry: fakeRegistry() });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  const body = exchange.response.json();
  assert.equal(body.providers[0].checkedAt, null);
  assert.ok("checkedAt" in body.providers[0]);
});

test("7. usage is always explicitly unavailable", async () => {
  const { handler } = handlerWith({ registry: fakeRegistry() });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  assert.deepEqual(exchange.response.json().usage, {
    available: false,
    source: "unavailable",
    requestsInWindow: null,
    requestLimit: null,
    remainingRequests: null,
    windowResetAt: null
  });
});

test("8. usage numeric fields are strictly null and never coerced to 0", async () => {
  const { handler } = handlerWith({ registry: fakeRegistry() });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  const usage = exchange.response.json().usage;
  for (const field of ["requestsInWindow", "requestLimit", "remainingRequests", "windowResetAt"]) {
    assert.equal(usage[field], null);
    assert.notEqual(usage[field], 0);
  }
});

test("9. a valid bearer token uses the timing-safe comparison path and succeeds", async () => {
  let comparisons = 0;
  const timingSafeEqualFn = (actual, expected) => { comparisons += 1; return actual.equals(expected); };
  const { handler } = handlerWith({ registry: fakeRegistry(), timingSafeEqualFn });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 200);
  assert.equal(comparisons, 1);
});

test("10. a missing Authorization header is rejected as AUTH_REQUIRED", async () => {
  const { handler } = handlerWith({ registry: fakeRegistry() });
  const exchange = ccExchange({ headers: {} });
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 403);
  assert.equal(exchange.response.json().error.code, "AUTH_REQUIRED");
});

test("11. a wrong bearer token is rejected as AUTH_INVALID", async () => {
  const { handler } = handlerWith({ registry: fakeRegistry() });
  const exchange = ccExchange({ headers: { authorization: "Bearer wrong-cc-service-token-0123456789abcdef" } });
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 403);
  assert.equal(exchange.response.json().error.code, "AUTH_INVALID");
});

test("12. missing server-side token configuration fails closed as AUTH_NOT_CONFIGURED", async () => {
  const { handler } = handlerWith({ env: {}, registry: fakeRegistry() });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 503);
  assert.equal(exchange.response.json().error.code, "AUTH_NOT_CONFIGURED");
});

test("13. a browser Origin header is blocked before authentication is even evaluated", async () => {
  const { handler } = handlerWith({ registry: fakeRegistry() });
  const exchange = ccExchange({ headers: { origin: "http://localhost:3000" } });
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 403);
  assert.equal(exchange.response.json().error.code, "ORIGIN_NOT_ALLOWED");
});

test("14. a non-GET method is rejected as METHOD_NOT_ALLOWED with an Allow header", async () => {
  const { handler } = handlerWith({ registry: fakeRegistry() });
  const exchange = ccExchange({ method: "POST" });
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 405);
  assert.equal(exchange.response.json().error.code, "METHOD_NOT_ALLOWED");
  assert.equal(exchange.response.headers.get("allow"), "GET");
});

test("15. an aggregation failure or timeout is reported as UPSTREAM_UNAVAILABLE and retryable", async () => {
  const thrown = handlerWith({ buildStatusData: () => { throw new Error("registry.status() blew up"); } });
  const thrownExchange = ccExchange();
  await thrown.handler(thrownExchange.request, thrownExchange.response);
  assert.equal(thrownExchange.response.statusCode, 503);
  assert.equal(thrownExchange.response.json().error.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(thrownExchange.response.json().error.retryable, true);

  const slow = handlerWith({
    buildStatusData: () => new Promise(() => {}),
    timeoutMs: 5
  });
  const slowExchange = ccExchange();
  await slow.handler(slowExchange.request, slowExchange.response);
  assert.equal(slowExchange.response.statusCode, 503);
  assert.equal(slowExchange.response.json().error.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(slowExchange.response.json().error.retryable, true);
});

test("16. an unrelated internal error is reported as INTERNAL_ERROR, not UPSTREAM_UNAVAILABLE", async () => {
  // Malformed aggregation output (missing activeModes) breaks response
  // building itself, outside the aggregation try/catch.
  const { handler } = handlerWith({ buildStatusData: () => ({ routerVersion: "x", routerStatus: "ok" }) });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 500);
  assert.equal(exchange.response.json().error.code, "INTERNAL_ERROR");
  assert.equal(exchange.response.json().error.retryable, false);
});

test("17. no secrets, tokens or stack traces ever reach the response body", async () => {
  const scenarios = [
    ccExchange({ headers: {} }),
    ccExchange({ headers: { authorization: "Bearer wrong-cc-service-token-0123456789abcdef" } }),
    ccExchange()
  ];
  for (const exchange of scenarios) {
    const { handler } = handlerWith({ registry: fakeRegistry() });
    await handler(exchange.request, exchange.response);
    const raw = exchange.response.body;
    assert.equal(raw.includes(TEST_CC_TOKEN), false);
    assert.equal(/\bat \S+ \(/.test(raw), false);
    assert.equal(raw.includes("node_modules"), false);
    assert.equal(/[A-Za-z]:\\/.test(raw), false);
  }
});

test("18. no secrets or token values are ever written to the log sink", async () => {
  const logEntries = [];
  const { handler } = handlerWith({ registry: fakeRegistry(), logEntries });
  const okExchange = ccExchange();
  await handler(okExchange.request, okExchange.response);
  const wrongExchange = ccExchange({ headers: { authorization: "Bearer wrong-cc-service-token-0123456789abcdef" } });
  await handler(wrongExchange.request, wrongExchange.response);
  const serialized = JSON.stringify(logEntries);
  assert.equal(serialized.includes(TEST_CC_TOKEN), false);
  assert.equal(serialized.includes("wrong-cc-service-token"), false);
});

test("19. existing router endpoints remain unchanged when served alongside the new cc/status route", async () => {
  const ownsTemporaryDataDir = !process.env.AI_ROUTER_DATA_DIR;
  if (ownsTemporaryDataDir) process.env.AI_ROUTER_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-cc-status-tests-"));
  const { createRouterServer } = await import("../orchestrator/server.js");
  try {
    const server = createRouterServer({ eventLogger: { log: async () => {} } });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const statusResponse = await fetch(`${baseUrl}/api/router/status`);
      assert.equal(statusResponse.status, 200);
      const status = await statusResponse.json();
      assert.equal(status.schemaVersion, "2.0");
      assert.deepEqual(status.activeModes, ["recommendation", "simulation"]);

      const healthResponse = await fetch(`${baseUrl}/api/health`);
      assert.equal(healthResponse.status, 200);

      const ccResponse = await fetch(`${baseUrl}/api/v1/cc/status`, { headers: { authorization: `Bearer ${process.env.AI_ROUTER_CC_TOKEN || ""}` } });
      // No AI_ROUTER_CC_TOKEN is configured in this process environment, so
      // the new route must fail closed rather than silently succeed or
      // interfere with the sibling routes checked above.
      assert.equal(ccResponse.status, 503);
      assert.equal((await ccResponse.json()).error.code, "AUTH_NOT_CONFIGURED");
    } finally {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    }
  } finally {
    if (ownsTemporaryDataDir) await fs.rm(process.env.AI_ROUTER_DATA_DIR, { recursive: true, force: true });
  }
});

test("20. success and failure payloads satisfy the strict cc-status-response-v1 schema", async () => {
  const schema = JSON.parse(await fs.readFile(new URL("../schemas/cc-status-response-v1.json", import.meta.url), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  const successDef = schema.$defs.success;
  const failureDef = schema.$defs.failure;
  const providerDef = schema.$defs.provider;
  const usageDef = schema.$defs.usage;
  assert.equal(successDef.additionalProperties, false);
  assert.equal(failureDef.additionalProperties, false);
  assert.equal(providerDef.additionalProperties, false);
  assert.equal(usageDef.additionalProperties, false);

  const { handler } = handlerWith({ registry: fakeRegistry() });
  const successExchange = ccExchange();
  await handler(successExchange.request, successExchange.response);
  const successBody = successExchange.response.json();
  assert.deepEqual(Object.keys(successBody).sort(), successDef.required.sort());
  assert.equal(successDef.properties.routerStatus.enum.includes(successBody.routerStatus), true);
  for (const provider of successBody.providers) {
    assert.deepEqual(Object.keys(provider).sort(), providerDef.required.sort());
    assert.equal(providerDef.properties.status.enum.includes(provider.status), true);
  }
  assert.deepEqual(Object.keys(successBody.usage).sort(), usageDef.required.sort());

  const failureExchange = ccExchange({ headers: {} });
  await handler(failureExchange.request, failureExchange.response);
  const failureBody = failureExchange.response.json();
  assert.deepEqual(Object.keys(failureBody).sort(), failureDef.required.sort());
  assert.equal(failureBody.status, "failed");
  assert.equal(schema.$defs.error.properties.code.enum.includes(failureBody.error.code), true);
});

test("buildCcStatusData is a pure, synchronous read of the real provider registry (no injected registry)", () => {
  const data = buildCcStatusData();
  assert.equal(typeof data.routerVersion, "string");
  assert.ok(["ok", "degraded"].includes(data.routerStatus));
  assert.deepEqual(data.activeModes, ["recommendation", "simulation"]);
  assert.ok(data.providers.length > 0);
  assert.equal(data.usage.available, false);
});
