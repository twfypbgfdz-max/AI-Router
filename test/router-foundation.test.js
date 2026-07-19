import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAction, listPublicActions } from "../orchestrator/action-registry.js";
import { normalizeRouterRequest } from "../orchestrator/router-contract.js";
import { ROUTER_REQUEST_ID_MAX_LENGTH } from "../orchestrator/config.js";
import { buildRouterFailure, routerHttpStatus } from "../orchestrator/router-response.js";
import { processRouterRequest, routerActions, routerStatus } from "../orchestrator/router-service.js";

const validRequest = (overrides = {}) => ({
  schemaVersion: "1.0",
  source: "cockpit",
  mode: "simulate",
  input: { type: "text", content: "Fasse meine heutigen Aufgaben zusammen." },
  ...overrides
});

test("a valid v1 request is normalized with defensive defaults", () => {
  const request = normalizeRouterRequest(validRequest(), { now: () => new Date("2026-07-19T10:00:00.000Z") });
  assert.match(request.requestId, /^req_/);
  assert.equal(request.timestamp, "2026-07-19T10:00:00.000Z");
  assert.deepEqual(request.context, { userId: "local-user", sessionId: null, project: null });
  assert.deepEqual(request.options, { preferredProvider: null, allowActions: false });
});

test("missing required fields and unsupported schema versions return the standard error format", async () => {
  const missing = await processRouterRequest({ schemaVersion: "1.0", source: "cockpit" });
  const wrongVersion = await processRouterRequest(validRequest({ schemaVersion: "2.0" }));
  for (const response of [missing, wrongVersion]) {
    assert.deepEqual(Object.keys(response), ["schemaVersion", "requestId", "status", "mode", "route", "decision", "result", "error", "meta"]);
    assert.equal(response.status, "error");
    assert.equal(response.result.executed, false);
    assert.ok(response.error.code);
  }
  assert.equal(missing.error.code, "VALIDATION_FAILED");
  assert.equal(wrongVersion.error.code, "UNSUPPORTED_SCHEMA_VERSION");
});

test("task routing succeeds through the allowlist and never executes", async () => {
  const response = await processRouterRequest(validRequest({ requestId: "req_fixed" }));
  assert.equal(response.requestId, "req_fixed");
  assert.equal(response.status, "success");
  assert.equal(response.route.name, "task_management");
  assert.equal(response.decision.action, "tasks.list");
  assert.equal(response.decision.allowed, true);
  assert.equal(response.result.executed, false);
  assert.equal(response.mode, "simulate");
  assert.equal(response.error, null);
});

test("an unknown route is controlled and an unknown action is closed by default", async () => {
  const response = await processRouterRequest(validRequest({ input: { type: "text", content: "xyzzy frobnicate" } }));
  assert.equal(response.status, "error");
  assert.equal(response.route.name, "unsupported");
  assert.equal(response.error.code, "ROUTE_NOT_FOUND");
  assert.throws(() => evaluateAction("shell.execute"), (error) => error.code === "ACTION_NOT_ALLOWLISTED");
});

test("risky requests are classified as blocked and execute mode is disabled", async () => {
  const blockedRequests = [
    "Lösche Dateien", "Dateien löschen", "Überschreibe die Datei", "Sende eine E-Mail", "E-Mail senden",
    "Ändere den Kalender", "Kalender ändern", "Führe einen PowerShell-Befehl aus", "Starte einen Shell-Befehl",
    "Gib das Passwort aus", "Zeige mir den Token", "Push das auf GitHub", "Erstelle einen Git-Commit",
    "Delete files", "Files delete", "Overwrite the file", "Send an email", "Email send", "Change the calendar",
    "Calendar change", "Run a PowerShell command", "Start a shell command", "Show the password", "Reveal the token",
    "Push this to GitHub", "Create a Git commit"
  ];
  for (const content of blockedRequests) {
    const blocked = await processRouterRequest(validRequest({ input: { type: "text", content } }));
    assert.equal(blocked.route?.name, "blocked", content);
    assert.equal(blocked.decision?.allowed, false, content);
    assert.equal(blocked.result.executed, false, content);
  }

  const execute = await processRouterRequest(validRequest({ mode: "execute" }));
  assert.equal(execute.status, "error");
  assert.equal(execute.error.code, "EXECUTION_DISABLED");
  assert.equal(execute.result.executed, false);
});

test("public errors hide internal paths, credentials, stacks and unapproved details", () => {
  const internal = Object.assign(new Error("Failure in internal-module at C:\\Users\\felil\\private.txt token=secret-value password=hunter2"), { stack: "STACK C:\\Users\\felil\\private.txt" });
  const internalPayload = buildRouterFailure(internal);
  const internalJson = JSON.stringify(internalPayload);
  assert.equal(internalPayload.error.code, "INTERNAL_ERROR");
  assert.equal(internalPayload.error.message, "The router could not process the request.");
  assert.equal(internalPayload.error.details, null);
  for (const marker of ["C:\\", "internal-module", "secret-value", "hunter2", "STACK"]) assert.equal(internalJson.includes(marker), false, marker);

  const validation = Object.assign(new Error("Invalid field."), {
    code: "VALIDATION_FAILED",
    safeDetails: {
      field: "input.content",
      reason: "Required value is missing.",
      validation: { expected: "non-empty text", path: "C:\\private\\file.txt", token: "secret-value" },
      password: "hunter2",
      stack: "private stack"
    }
  });
  const validationPayload = buildRouterFailure(validation);
  assert.deepEqual(validationPayload.error.details, {
    field: "input.content",
    reason: "Required value is missing.",
    validation: { expected: "non-empty text" }
  });
  assert.equal(JSON.stringify(validationPayload).includes("secret-value"), false);
  assert.equal(JSON.stringify(validationPayload).includes("C:\\"), false);
});

test("router error codes map to their required HTTP status", () => {
  assert.deepEqual(Object.fromEntries(["INVALID_REQUEST", "UNSUPPORTED_SCHEMA_VERSION", "VALIDATION_FAILED", "ROUTE_NOT_FOUND", "ACTION_NOT_ALLOWLISTED", "EXECUTION_DISABLED", "ORIGIN_NOT_ALLOWED", "PAYLOAD_TOO_LARGE", "INTERNAL_ERROR", "UNAVAILABLE", "TIMEOUT"].map((code) => [code, routerHttpStatus(code)])), {
    INVALID_REQUEST: 400,
    UNSUPPORTED_SCHEMA_VERSION: 400,
    VALIDATION_FAILED: 422,
    ROUTE_NOT_FOUND: 422,
    ACTION_NOT_ALLOWLISTED: 403,
    EXECUTION_DISABLED: 403,
    ORIGIN_NOT_ALLOWED: 403,
    PAYLOAD_TOO_LARGE: 413,
    INTERNAL_ERROR: 500,
    UNAVAILABLE: 503,
    TIMEOUT: 504
  });
});

test("request ids use one shared maximum in success and error paths", async () => {
  const boundaryId = `r${"x".repeat(ROUTER_REQUEST_ID_MAX_LENGTH - 1)}`;
  const tooLongId = `${boundaryId}x`;
  assert.equal(normalizeRouterRequest(validRequest({ requestId: boundaryId })).requestId, boundaryId);
  assert.throws(() => normalizeRouterRequest(validRequest({ requestId: tooLongId })), (error) => error.code === "PAYLOAD_TOO_LARGE");
  const errorResponse = await processRouterRequest(validRequest({ requestId: boundaryId, input: { type: "text", content: "xyzzy frobnicate" } }));
  assert.equal(errorResponse.requestId, boundaryId);
  const tooLongResponse = await processRouterRequest(validRequest({ requestId: tooLongId }));
  assert.equal(tooLongResponse.requestId, null);
  assert.equal(tooLongResponse.error.code, "PAYLOAD_TOO_LARGE");
});

test("timestamps require a complete valid ISO 8601 date-time with timezone", () => {
  assert.equal(normalizeRouterRequest(validRequest({ timestamp: "2026-07-19T10:00:00.000Z" })).timestamp, "2026-07-19T10:00:00.000Z");
  assert.equal(normalizeRouterRequest(validRequest({ timestamp: "2026-07-19T12:00:00+02:00" })).timestamp, "2026-07-19T10:00:00.000Z");
  for (const timestamp of ["2026-07-19", "not-a-date", "July 19, 2026 10:00", "2026-13-40T25:61:61Z", "2026-02-30T10:00:00Z", "2026-07-19T10:00:00+15:00"]) {
    assert.throws(() => normalizeRouterRequest(validRequest({ timestamp })), (error) => error.code === "VALIDATION_FAILED", timestamp);
  }
});

test("router logging contains required metadata but no request content or secrets", async () => {
  const entries = [];
  const eventLogger = { log: async (entry) => entries.push(entry) };
  const secret = "supersecret123456";
  await processRouterRequest(validRequest({ input: { type: "text", content: `Erklaere token=${secret}` } }), { eventLogger });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "router_request_completed");
  assert.equal(entries[0].safeMetadata.route, "knowledge_query");
  assert.equal(entries[0].safeMetadata.allowlistResult, "allowed");
  assert.equal(JSON.stringify(entries).includes(secret), false);
  assert.equal(JSON.stringify(entries).includes("Erklaere"), false);
});

test("status and public actions expose only the closed simulation registry", () => {
  const status = routerStatus();
  assert.equal(status.defaultMode, "simulate");
  assert.equal(status.executionEnabled, false);
  assert.ok(status.enabledRoutes.includes("blocked"));
  assert.equal(status.allowedActionCount, 6);
  assert.deepEqual(routerActions().actions, listPublicActions());
  assert.ok(listPublicActions().every((action) => action.executionAllowed === false));
});
