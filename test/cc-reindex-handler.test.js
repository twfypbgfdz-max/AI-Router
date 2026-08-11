import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCcReindexHandler } from "../orchestrator/cc-reindex-handler.js";
import { RagError } from "../orchestrator/knowledge/rag-error.js";
import { fakeHttpExchange } from "./text-response-helpers.js";

const TEST_CC_TOKEN = "test-cc-service-token-0123456789abcdef";

function ccEnv(overrides = {}) {
  return { AI_ROUTER_CC_TOKEN: TEST_CC_TOKEN, ...overrides };
}

function ccExchange({ method = "POST", headers, ...rest } = {}) {
  return fakeHttpExchange({
    method,
    headers: headers ?? { authorization: `Bearer ${TEST_CC_TOKEN}` },
    ...rest
  });
}

function successfulReindex(overrides = {}) {
  return {
    documentsProcessed: 10,
    documentsRejectedFromAllowlist: [],
    chunkCount: 157,
    forceFullReindex: false,
    ...overrides
  };
}

function handlerWith({
  env = ccEnv(),
  logEntries = [],
  timingSafeEqualFn,
  wallClock,
  runRagReindexFn,
  timeoutMs,
  setTimer,
  clearTimer
} = {}) {
  return {
    handler: createCcReindexHandler({
      env,
      timingSafeEqualFn,
      wallClock,
      runRagReindexFn,
      timeoutMs,
      setTimer,
      clearTimer,
      eventLogger: { log: async (entry) => { logEntries.push(entry); } }
    }),
    logEntries
  };
}

test("1. valid success response has the exact required shape and no top-level status field", async () => {
  const { handler } = handlerWith({ runRagReindexFn: async () => successfulReindex() });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 200);
  const body = exchange.response.json();
  assert.deepEqual(
    Object.keys(body).sort(),
    ["chunkCount", "documentsProcessed", "documentsRejectedFromAllowlist", "error", "forceFullReindex", "generatedAt", "schemaVersion"].sort()
  );
  assert.equal(body.schemaVersion, "1.0");
  assert.equal(body.error, null);
  assert.ok(Number.isFinite(Date.parse(body.generatedAt)));
  assert.equal(body.documentsProcessed, 10);
  assert.equal(body.chunkCount, 157);
  assert.equal(body.forceFullReindex, false);
});

test("2. rejected allowlist entries pass through only relativePath and code, never message", async () => {
  const { handler } = handlerWith({
    runRagReindexFn: async () => successfulReindex({
      documentsRejectedFromAllowlist: [
        { relativePath: "60_Finanzen/geheim.md", code: "ALLOWLIST_ENTRY_DENIED", message: "internal detail that must not leak" }
      ]
    })
  });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  const body = exchange.response.json();
  assert.deepEqual(body.documentsRejectedFromAllowlist, [
    { relativePath: "60_Finanzen/geheim.md", code: "ALLOWLIST_ENTRY_DENIED" }
  ]);
  assert.equal(exchange.response.body.includes("internal detail"), false);
});

test("3. a valid bearer token uses the timing-safe comparison path and succeeds", async () => {
  let comparisons = 0;
  const timingSafeEqualFn = (actual, expected) => { comparisons += 1; return actual.equals(expected); };
  const { handler } = handlerWith({ runRagReindexFn: async () => successfulReindex(), timingSafeEqualFn });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 200);
  assert.equal(comparisons, 1);
});

test("4. a missing Authorization header is rejected as AUTH_REQUIRED", async () => {
  const { handler } = handlerWith({ runRagReindexFn: async () => successfulReindex() });
  const exchange = ccExchange({ headers: {} });
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 403);
  assert.equal(exchange.response.json().error.code, "AUTH_REQUIRED");
});

test("5. a wrong bearer token is rejected as AUTH_INVALID", async () => {
  const { handler } = handlerWith({ runRagReindexFn: async () => successfulReindex() });
  const exchange = ccExchange({ headers: { authorization: "Bearer wrong-cc-service-token-0123456789abcdef" } });
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 403);
  assert.equal(exchange.response.json().error.code, "AUTH_INVALID");
});

test("6. missing server-side token configuration fails closed as AUTH_NOT_CONFIGURED", async () => {
  const { handler } = handlerWith({ env: {}, runRagReindexFn: async () => successfulReindex() });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 503);
  assert.equal(exchange.response.json().error.code, "AUTH_NOT_CONFIGURED");
});

test("7. a browser Origin header is blocked before authentication is even evaluated", async () => {
  const { handler } = handlerWith({ runRagReindexFn: async () => successfulReindex() });
  const exchange = ccExchange({ headers: { origin: "http://localhost:3000" } });
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 403);
  assert.equal(exchange.response.json().error.code, "ORIGIN_NOT_ALLOWED");
});

test("8. a non-POST method is rejected as METHOD_NOT_ALLOWED with an Allow header", async () => {
  const { handler } = handlerWith({ runRagReindexFn: async () => successfulReindex() });
  const exchange = ccExchange({ method: "GET" });
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 405);
  assert.equal(exchange.response.json().error.code, "METHOD_NOT_ALLOWED");
  assert.equal(exchange.response.headers.get("allow"), "POST");
});

test("9. OPTIONS is answered with 204 and an Allow header, without touching auth or the reindex run", async () => {
  let called = false;
  const { handler } = handlerWith({ runRagReindexFn: async () => { called = true; return successfulReindex(); } });
  const exchange = ccExchange({ method: "OPTIONS", headers: {} });
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 204);
  assert.equal(exchange.response.headers.get("allow"), "POST, OPTIONS");
  assert.equal(called, false);
});

test("10. a second request inside the rate window is rejected as RATE_LIMITED with Retry-After, the run is never called twice", async () => {
  let calls = 0;
  const { handler } = handlerWith({ runRagReindexFn: async () => { calls += 1; return successfulReindex(); } });
  const first = ccExchange();
  await handler(first.request, first.response);
  assert.equal(first.response.statusCode, 200);

  const second = ccExchange();
  await handler(second.request, second.response);
  assert.equal(second.response.statusCode, 429);
  assert.equal(second.response.json().error.code, "RATE_LIMITED");
  assert.equal(second.response.json().error.retryable, true);
  assert.ok(Number(second.response.headers.get("retry-after")) > 0);
  assert.equal(calls, 1);
});

test("11. an overlapping request while a run is in flight is rejected, the run is never invoked twice, and the slot frees up after completion", async () => {
  let release;
  let calls = 0;
  const inFlight = new Promise((resolve) => { release = resolve; });
  const { handler } = handlerWith({
    runRagReindexFn: async () => { calls += 1; await inFlight; return successfulReindex(); }
  });
  const first = ccExchange();
  const firstPromise = handler(first.request, first.response);

  const second = ccExchange();
  await handler(second.request, second.response);
  assert.equal(second.response.statusCode, 429);
  // With CC_REINDEX_MAX_REQUESTS_PER_WINDOW and CC_REINDEX_MAX_CONCURRENT_REQUESTS
  // both at 1 and a single shared internal identity (see internal-auth.js:
  // identityFingerprint is derived from the expected token, not the caller),
  // the rate check runs and rejects before the concurrency check ever would -
  // matching the same documented reality as cc-summary-handler.test.js and
  // text-response-handler.js for their own 1/1 endpoints. This request never
  // reaches the concurrency check, so it surfaces as RATE_LIMITED, not
  // CONCURRENCY_LIMITED - both are 429 and neither invokes the run.
  assert.equal(second.response.json().error.code, "RATE_LIMITED");
  assert.equal(calls, 1);

  release();
  await firstPromise;
  assert.equal(first.response.statusCode, 200);
});

test("12. a structural RagError is reported as REINDEX_FAILED, not retryable, with the closed error code as reason", async () => {
  const { handler } = handlerWith({
    runRagReindexFn: async () => { throw new RagError("ALLOWLIST_INVALID", "Allowlist file is not valid JSON."); }
  });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 502);
  const body = exchange.response.json();
  assert.equal(body.error.code, "REINDEX_FAILED");
  assert.equal(body.error.retryable, false);
  assert.equal(body.error.reason, "ALLOWLIST_INVALID");
});

test("13. a transient RagError (e.g. embedding provider unreachable) is reported as retryable", async () => {
  const { handler } = handlerWith({
    runRagReindexFn: async () => { throw new RagError("EMBEDDING_PROVIDER_UNAVAILABLE", "Ollama is not reachable for embeddings."); }
  });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  const body = exchange.response.json();
  assert.equal(body.error.code, "REINDEX_FAILED");
  assert.equal(body.error.retryable, true);
  assert.equal(body.error.reason, "EMBEDDING_PROVIDER_UNAVAILABLE");
});

test("14. a run that exceeds the timeout is reported as REINDEX_FAILED and retryable", async () => {
  const { handler } = handlerWith({
    runRagReindexFn: () => new Promise(() => {}),
    timeoutMs: 5
  });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  const body = exchange.response.json();
  assert.equal(body.error.code, "REINDEX_FAILED");
  assert.equal(body.error.retryable, true);
});

test("15. an unrelated internal error is reported as INTERNAL_ERROR, not REINDEX_FAILED", async () => {
  const { handler } = handlerWith({
    runRagReindexFn: async () => { throw new Error("unexpected wiring bug"); }
  });
  const exchange = ccExchange();
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 500);
  const body = exchange.response.json();
  assert.equal(body.error.code, "INTERNAL_ERROR");
  assert.equal(body.error.reason, null);
});

test("16. no secrets, tokens or stack traces ever reach the response body", async () => {
  const scenarios = [
    () => ccExchange({ headers: {} }),
    () => ccExchange({ headers: { authorization: "Bearer wrong-cc-service-token-0123456789abcdef" } }),
    () => ccExchange()
  ];
  for (const build of scenarios) {
    const { handler } = handlerWith({ runRagReindexFn: async () => successfulReindex() });
    const exchange = build();
    await handler(exchange.request, exchange.response);
    const raw = exchange.response.body;
    assert.equal(raw.includes(TEST_CC_TOKEN), false);
    assert.equal(/\bat \S+ \(/.test(raw), false);
    assert.equal(raw.includes("node_modules"), false);
    assert.equal(/[A-Za-z]:\\/.test(raw), false);
  }
});

test("17. no secrets or token values are ever written to the log sink", async () => {
  const logEntries = [];
  const { handler } = handlerWith({ runRagReindexFn: async () => successfulReindex(), logEntries });
  const okExchange = ccExchange();
  await handler(okExchange.request, okExchange.response);
  const wrongExchange = ccExchange({ headers: { authorization: "Bearer wrong-cc-service-token-0123456789abcdef" } });
  await handler(wrongExchange.request, wrongExchange.response);
  const serialized = JSON.stringify(logEntries);
  assert.equal(serialized.includes(TEST_CC_TOKEN), false);
  assert.equal(serialized.includes("wrong-cc-service-token"), false);
});

test("18. existing router endpoints remain unchanged when served alongside the new cc/reindex route", async () => {
  const ownsTemporaryDataDir = !process.env.AI_ROUTER_DATA_DIR;
  if (ownsTemporaryDataDir) process.env.AI_ROUTER_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-cc-reindex-tests-"));
  const { createRouterServer } = await import("../orchestrator/server.js");
  try {
    const server = createRouterServer({ eventLogger: { log: async () => {} } });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const statusResponse = await fetch(`${baseUrl}/api/router/status`);
      assert.equal(statusResponse.status, 200);

      const ccStatusResponse = await fetch(`${baseUrl}/api/v1/cc/status`, { headers: { authorization: `Bearer ${process.env.AI_ROUTER_CC_TOKEN || ""}` } });
      assert.equal(ccStatusResponse.status, 503);

      // No AI_ROUTER_CC_TOKEN is configured in this process environment, so
      // the new route must fail closed rather than silently succeed or
      // interfere with the sibling routes checked above.
      const reindexResponse = await fetch(`${baseUrl}/api/v1/cc/reindex`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.AI_ROUTER_CC_TOKEN || ""}` }
      });
      assert.equal(reindexResponse.status, 503);
      assert.equal((await reindexResponse.json()).error.code, "AUTH_NOT_CONFIGURED");
    } finally {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    }
  } finally {
    if (ownsTemporaryDataDir) await fs.rm(process.env.AI_ROUTER_DATA_DIR, { recursive: true, force: true });
  }
});
