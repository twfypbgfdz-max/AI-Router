import test from "node:test";
import assert from "node:assert/strict";
import { handleVercelRouterRoute, handleVercelRouterStatus } from "../orchestrator/vercel-router-handler.js";

function response() {
  return {
    headers: new Map(), statusCode: 0, body: "",
    setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
    end(value = "") { this.body = value; return this; }
  };
}

function request(body, overrides = {}) {
  return { method: "POST", headers: { "content-type": "application/json" }, body, ...overrides };
}

function validBody(overrides = {}) {
  return { schemaVersion: "2.0", source: "cockpit", mode: "simulation", intent: "auto", input: { type: "text", content: "Cockpit-Projektstatus zusammenfassen" }, ...overrides };
}

test("Vercel status handler is read-only, bounded and exposes the canonical router state", async () => {
  const ok = response();
  await handleVercelRouterStatus({ method: "GET", headers: {} }, ok);
  const payload = JSON.parse(ok.body);
  assert.equal(ok.statusCode, 200);
  assert.equal(payload.schemaVersion, "2.0");
  assert.deepEqual(payload.activeModes, ["recommendation", "simulation"]);
  assert.equal(payload.executionEnabled, false);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");

  const post = response();
  await handleVercelRouterStatus({ method: "POST", headers: {} }, post);
  assert.equal(post.statusCode, 405);
});

test("Vercel route handler uses the central core and never enables execution", async () => {
  const res = response();
  await handleVercelRouterRoute(request(validBody()), res);
  const payload = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.status, "simulated");
  assert.equal(payload.simulation.executed, false);
  assert.equal(payload.simulation.executionStatus, "never_executed");
  assert.equal(payload.meta.executionEnabled, false);
  assert.equal(payload.recommendation.recommendedProvider.externalCallAllowed, false);
});

test("Vercel route handler rejects execution, invalid origins, methods and oversized bodies", async () => {
  const execution = response();
  await handleVercelRouterRoute(request(validBody({ mode: "execution" })), execution);
  assert.equal(execution.statusCode, 422);
  assert.equal(JSON.parse(execution.body).error.code, "MODE_NOT_ALLOWED");

  const origin = response();
  await handleVercelRouterRoute(request(validBody(), { headers: { "content-type": "application/json", origin: "https://evil.example" } }), origin);
  assert.equal(origin.statusCode, 403);
  assert.equal(JSON.parse(origin.body).error.code, "ORIGIN_NOT_ALLOWED");

  const get = response();
  await handleVercelRouterRoute(request(validBody(), { method: "GET" }), get);
  assert.equal(get.statusCode, 405);

  const large = response();
  await handleVercelRouterRoute(request(validBody(), { headers: { "content-type": "application/json", "content-length": "20000" } }), large);
  assert.equal(large.statusCode, 413);
  assert.equal(JSON.parse(large.body).error.code, "PAYLOAD_TOO_LARGE");
});

test("Vercel route handler returns safe failures without stack traces or request text", async () => {
  const rejected = response();
  await handleVercelRouterRoute(request(validBody({ input: { type: "text", content: "Lösche alle Dateien und pushe in Produktion" } })), rejected);
  const payload = JSON.parse(rejected.body);
  assert.equal(rejected.statusCode, 403);
  assert.equal(payload.status, "rejected");
  assert.equal(payload.error.code, "CAPABILITY_NOT_ALLOWED");
  assert.equal(payload.simulation, null);
  assert.equal(rejected.body.includes("Lösche alle Dateien"), false);
  assert.equal(rejected.body.toLowerCase().includes("stack"), false);
});
