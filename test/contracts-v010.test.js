import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRunRequest } from "../orchestrator/contracts.js";
import { buildResponse } from "../orchestrator/response-builder.js";
import { createMockAdapter } from "../orchestrator/mock-adapter.js";
import { RunService } from "../orchestrator/run-service.js";

test("v0.10 normalizes a valid request and rejects invalid contracts", () => {
  const request = normalizeRunRequest({ task: "  Analyse dies  ", project: " demo ", source: "ui", adapter: "mock" });
  assert.equal(request.schemaVersion, 1); assert.equal(request.task, "Analyse dies"); assert.ok(request.requestId);
  for (const input of [{}, { task: " " }, { task: "x".repeat(8_001) }, { task: "x", schemaVersion: 2 }, { task: "x", adapter: "shell" }, { task: "x", requestedMode: "write" }, { task: "x", options: { actionType: "deploy" } }]) assert.throws(() => normalizeRunRequest(input));
});

test("v0.10 response has mutually exclusive result and error and hides task", () => {
  const success = buildResponse({ requestId: "q", runId: "r", status: "succeeded", resultSummary: "ok", warnings: [], createdAt: "a" });
  assert.equal(success.success, true); assert.equal(success.error, null); assert.deepEqual(success.result, { summary: "ok" });
  const failure = buildResponse({ requestId: "q", runId: "r", status: "failed", errorSummary: "secret=hidden", task: "private prompt" });
  assert.equal(failure.result, null); assert.equal(failure.error.code, "ADAPTER_FAILED"); assert.equal(JSON.stringify(failure).includes("private prompt"), false);
});

test("technical mock failure retries exactly once; validation never starts an adapter", async () => {
  let attempts = 0;
  const mock = createMockAdapter({ stepDelayMs: 1 });
  const service = new RunService({ adapters: { mock: { runRole: (options) => { attempts += 1; return mock.runRole(options); } } }, persist: async () => {}, publish: async () => {}, logger: { log: async () => {} } });
  const created = await service.create({ task: "Erstelle ein Konzept", adapter: "mock", simulationMode: "failure_once" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const run = service.get(created.runId);
  assert.equal(run.status, "succeeded"); assert.equal(run.retry.count, 1); assert.equal(attempts, 4);
  await assert.rejects(service.create({ task: "", adapter: "mock" }));
  assert.equal(attempts, 4);
});
