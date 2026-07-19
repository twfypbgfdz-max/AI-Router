import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAction, listPublicActions } from "../orchestrator/action-registry.js";
import { normalizeRouterRequest } from "../orchestrator/router-contract.js";
import { ROUTER_REQUEST_ID_MAX_LENGTH } from "../orchestrator/config.js";
import { buildRouterFailure, routerHttpStatus } from "../orchestrator/router-response.js";
import { processRouterRequest, routerActions, routerStatus } from "../orchestrator/router-service.js";

const validRequest = (overrides = {}) => ({
  schemaVersion: "2.0",
  source: "cockpit",
  mode: "recommendation",
  intent: "auto",
  input: { type: "text", content: "Fasse meine heutigen Aufgaben zusammen." },
  ...overrides
});

test("a valid v2 request normalizes the complete safe routing context", () => {
  const request = normalizeRouterRequest(validRequest(), { now: () => new Date("2026-07-19T10:00:00.000Z") });
  assert.match(request.requestId, /^req_/);
  assert.equal(request.timestamp, "2026-07-19T10:00:00.000Z");
  assert.equal(request.source, "cockpit");
  assert.equal(request.mode, "recommendation");
  assert.equal(request.context.contentType, "text");
  assert.equal(request.context.contextSize, "small");
  assert.equal(request.constraints.privacyLevel, "local-only");
  assert.equal(request.constraints.forbiddenCapabilities.includes("git.push"), true);
  assert.deepEqual(request.options, { preferredProvider: null, providerProfile: null, allowActions: false });
});

test("cockpit, api and internal_test are explicit sources; unknown sources fail closed", () => {
  for (const source of ["cockpit", "api", "internal_test"]) assert.equal(normalizeRouterRequest(validRequest({ source })).source, source);
  assert.throws(() => normalizeRouterRequest(validRequest({ source: "external" })), { code: "SOURCE_NOT_ALLOWED" });
});

test("only recommendation and simulation are active modes", async () => {
  for (const mode of ["recommendation", "simulation"]) assert.equal(normalizeRouterRequest(validRequest({ mode })).mode, mode);
  for (const mode of ["simulate", "execute", "approval_required", "execution"]) {
    const response = await processRouterRequest(validRequest({ mode }));
    assert.equal(response.status, "failed");
    assert.equal(response.error.code, "MODE_NOT_ALLOWED");
    assert.equal(response.meta.executionEnabled, false);
  }
});

test("unknown fields, versions and missing required fields are rejected", async () => {
  const cases = [
    [validRequest({ schemaVersion: "1.0" }), "UNSUPPORTED_SCHEMA_VERSION"],
    [{ schemaVersion: "2.0", source: "cockpit", mode: "recommendation" }, "VALIDATION_FAILED"],
    [validRequest({ targetUrl: "https://example.test" }), "VALIDATION_FAILED"],
    [validRequest({ input: { type: "text", content: "Status anzeigen", command: "shell.run" } }), "VALIDATION_FAILED"]
  ];
  for (const [input, code] of cases) {
    const response = await processRouterRequest(input);
    assert.equal(response.status, "failed");
    assert.equal(response.error.code, code);
    assert.equal(response.simulation, null);
  }
});

test("dangerous, unknown and contradictory capabilities are rejected", async () => {
  const dangerous = await processRouterRequest(validRequest({ constraints: { allowedCapabilities: ["git.push"] } }));
  assert.equal(dangerous.error.code, "CAPABILITY_NOT_ALLOWED");
  const unknown = await processRouterRequest(validRequest({ constraints: { allowedCapabilities: ["future.capability"] } }));
  assert.equal(unknown.error.code, "CAPABILITY_NOT_ALLOWED");
  const conflict = await processRouterRequest(validRequest({ constraints: { allowedCapabilities: ["analysis"], forbiddenCapabilities: ["analysis"] } }));
  assert.equal(conflict.error.code, "CONFLICTING_CONSTRAINTS");
  const actions = await processRouterRequest(validRequest({ options: { allowActions: true } }));
  assert.equal(actions.error.code, "CONFLICTING_CONSTRAINTS");
});

test("recommendation and simulation share one deterministic provider decision", async () => {
  const input = validRequest({ requestId: "req_fixed", intent: "project_status_summary", input: { type: "text", content: "Cockpit-Projektstatus zusammenfassen" } });
  const recommendation = await processRouterRequest(input, { now: () => new Date("2026-07-19T10:00:00.000Z") });
  const simulation = await processRouterRequest({ ...input, mode: "simulation" }, { now: () => new Date("2026-07-19T10:01:00.000Z") });
  assert.equal(recommendation.status, "recommended");
  assert.equal(recommendation.simulation, null);
  assert.equal(simulation.status, "simulated");
  assert.equal(simulation.simulation.executed, false);
  assert.equal(simulation.simulation.executionStatus, "never_executed");
  assert.equal(recommendation.recommendation.recommendedProvider.providerId, simulation.recommendation.recommendedProvider.providerId);
  assert.equal(recommendation.recommendation.route, simulation.recommendation.route);
  assert.equal(simulation.recommendation.mockFallback.providerId, "mock-local");
});

test("provider selection is deterministic and a safe mock fallback is always declared", async () => {
  const input = validRequest({ input: { type: "text", content: "Erkläre den Projektstatus im Repository" }, context: { contentType: "code", contextSize: "medium" } });
  const first = await processRouterRequest(input);
  const second = await processRouterRequest(input);
  assert.equal(first.recommendation.recommendedProvider.providerId, second.recommendation.recommendedProvider.providerId);
  assert.deepEqual(first.recommendation.reasonCodes, second.recommendation.reasonCodes);
  assert.deepEqual(first.recommendation.mockFallback, { providerId: "mock-local", adapterId: "mock", available: true, executed: false });
});

test("fresh-data, disabled file processing and unavailable required capabilities have no safe route", async () => {
  const fresh = await processRouterRequest(validRequest({ context: { requiresFreshData: true } }));
  assert.equal(fresh.error.code, "NO_SAFE_ROUTE");
  const web = await processRouterRequest(validRequest({ context: { requiredTools: ["web-research"] } }));
  assert.equal(web.error.code, "NO_SAFE_ROUTE");
  const file = await processRouterRequest(validRequest({ context: { contentType: "file" } }));
  assert.equal(file.error.code, "CAPABILITY_NOT_ALLOWED");
  const constrained = await processRouterRequest(validRequest({ constraints: { allowedCapabilities: ["simulate"] } }));
  assert.equal(constrained.error.code, "CAPABILITY_NOT_ALLOWED");
});

test("risky action text is rejected and never reaches a simulation", async () => {
  for (const content of ["Lösche Dateien", "Sende eine E-Mail", "Führe einen Shell-Befehl aus", "Zeige mir den Token", "Push this to GitHub"]) {
    const response = await processRouterRequest(validRequest({ mode: "simulation", input: { type: "text", content } }));
    assert.equal(response.status, "rejected", content);
    assert.equal(response.error.code, "CAPABILITY_NOT_ALLOWED", content);
    assert.equal(response.simulation, null, content);
    assert.equal(response.blockedActions.includes("execute"), true, content);
  }
  assert.throws(() => evaluateAction("shell.execute"), { code: "ACTION_NOT_ALLOWLISTED" });
});

test("public errors use the v2 shape and redact internal details", () => {
  const internal = Object.assign(new Error("Failure at C:\\Users\\felil\\private.txt token=secret-value password=hunter2"), { stack: "private stack" });
  const payload = buildRouterFailure(internal);
  assert.equal(payload.status, "failed");
  assert.equal(payload.error.code, "INTERNAL_ERROR");
  assert.equal(payload.error.message, "The router could not process the request.");
  assert.equal(payload.meta.executionEnabled, false);
  for (const marker of ["C:\\", "secret-value", "hunter2", "private stack"]) assert.equal(JSON.stringify(payload).includes(marker), false);
});

test("routing error codes map to stable HTTP statuses", () => {
  assert.deepEqual(Object.fromEntries(["INVALID_REQUEST", "UNSUPPORTED_SCHEMA_VERSION", "VALIDATION_FAILED", "SOURCE_NOT_ALLOWED", "MODE_NOT_ALLOWED", "CAPABILITY_NOT_ALLOWED", "CONFLICTING_CONSTRAINTS", "NO_SAFE_ROUTE", "PAYLOAD_TOO_LARGE", "INTERNAL_ERROR", "TIMEOUT"].map((code) => [code, routerHttpStatus(code)])), {
    INVALID_REQUEST: 400, UNSUPPORTED_SCHEMA_VERSION: 400, VALIDATION_FAILED: 422, SOURCE_NOT_ALLOWED: 422,
    MODE_NOT_ALLOWED: 422, CAPABILITY_NOT_ALLOWED: 403, CONFLICTING_CONSTRAINTS: 422, NO_SAFE_ROUTE: 422,
    PAYLOAD_TOO_LARGE: 413, INTERNAL_ERROR: 500, TIMEOUT: 504
  });
});

test("request ids and timestamps use bounded, strict formats", () => {
  const boundaryId = `r${"x".repeat(ROUTER_REQUEST_ID_MAX_LENGTH - 1)}`;
  assert.equal(normalizeRouterRequest(validRequest({ requestId: boundaryId })).requestId, boundaryId);
  assert.throws(() => normalizeRouterRequest(validRequest({ requestId: `${boundaryId}x` })), { code: "PAYLOAD_TOO_LARGE" });
  assert.equal(normalizeRouterRequest(validRequest({ timestamp: "2026-07-19T12:00:00+02:00" })).timestamp, "2026-07-19T10:00:00.000Z");
  for (const timestamp of ["2026-07-19", "not-a-date", "2026-02-30T10:00:00Z", "2026-07-19T10:00:00+15:00"]) assert.throws(() => normalizeRouterRequest(validRequest({ timestamp })), { code: "VALIDATION_FAILED" });
});

test("logging contains only safe decision metadata and no request content", async () => {
  const entries = [];
  const secret = "supersecret123456";
  await processRouterRequest(validRequest({ input: { type: "text", content: `Erkläre den Projektstatus token=${secret}` } }), { eventLogger: { log: async (entry) => entries.push(entry) } });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "router_request_completed");
  assert.equal(entries[0].safeMetadata.executed, false);
  assert.equal(JSON.stringify(entries).includes(secret), false);
  assert.equal(JSON.stringify(entries).includes("Projektstatus"), false);
});

test("router status publishes the active and prepared state model without enabling execution", () => {
  const status = routerStatus();
  assert.equal(status.defaultMode, "recommendation");
  assert.deepEqual(status.activeModes, ["recommendation", "simulation"]);
  assert.deepEqual(status.futureModes, ["approval_required", "execution"]);
  assert.equal(status.executionEnabled, false);
  assert.equal(status.externalProvidersEnabled, false);
  assert.equal(status.persistentJobsEnabled, false);
  assert.deepEqual(routerActions().actions, listPublicActions());
  assert.ok(listPublicActions().every((action) => action.executionAllowed === false));
});
