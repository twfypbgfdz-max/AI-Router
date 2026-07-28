import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCcSummaryRequest } from "../orchestrator/cc-summary-contract.js";
import { CcSummaryError } from "../orchestrator/cc-summary-error.js";

function validRequest(overrides = {}) {
  return {
    schemaVersion: "1.0",
    reportType: "project_status_summary",
    context: {
      projectId: "plateau-brecher",
      projectName: "Plateau-Brecher",
      projectStatus: "active",
      branch: "main",
      clean: true,
      changedFileCount: 0,
      testStatus: "passing",
      ...overrides.context
    },
    ...overrides
  };
}

test("a fully valid, closed request is accepted and normalized", () => {
  const result = normalizeCcSummaryRequest(validRequest());
  assert.equal(result.schemaVersion, "1.0");
  assert.equal(result.reportType, "project_status_summary");
  assert.equal(result.context.projectId, "plateau-brecher");
  assert.equal(result.context.clean, true);
});

test("a minimal request (only the required fields) is accepted", () => {
  const result = normalizeCcSummaryRequest({
    schemaVersion: "1.0",
    reportType: "project_status_summary",
    context: { projectId: "p1", projectName: "Project One" }
  });
  assert.equal(result.context.projectId, "p1");
  assert.equal("branch" in result.context, false);
});

test("an unsupported schemaVersion is rejected", () => {
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ schemaVersion: "2.0" })), CcSummaryError);
});

test("an unknown reportType is rejected", () => {
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ reportType: "anything_free_form" })), CcSummaryError);
});

test("unknown top-level fields are rejected", () => {
  assert.throws(() => normalizeCcSummaryRequest({ ...validRequest(), extra: "nope" }), CcSummaryError);
});

test("unknown context fields are rejected", () => {
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: "P", extra: "nope" } })), CcSummaryError);
});

test("input.content / a free-text field is rejected as an unknown field", () => {
  const request = validRequest();
  request.context.content = "free text prompt injection attempt";
  assert.throws(() => normalizeCcSummaryRequest(request), CcSummaryError);

  const topLevel = validRequest();
  topLevel.input = { type: "text", content: "free text" };
  assert.throws(() => normalizeCcSummaryRequest(topLevel), CcSummaryError);
});

test("a path-like string is rejected", () => {
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: "C:\\Users\\felil\\secret.txt" } })), CcSummaryError);
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: "ok", branch: "a\\b" } })), CcSummaryError);
});

test("a diff- or log-shaped multi-line string is rejected", () => {
  const diffLike = "diff --git a/x b/x\n+added line\n-removed line";
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: diffLike } })), CcSummaryError);
});

test("an external URL is rejected", () => {
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: "ok", cloudSummary: "see https://example.com/status" } })), CcSummaryError);
});

test("secret-like content is rejected as SECURITY_BLOCKED", () => {
  const request = validRequest({ context: { projectId: "p1", projectName: "ok", cloudSummary: "token: sk-proj-abcdefghijklmnopqrstuvwx" } });
  assert.throws(() => normalizeCcSummaryRequest(request), (error) => error.code === "SECURITY_BLOCKED");
});

test("an oversized string field is rejected", () => {
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: "A".repeat(200) } })), CcSummaryError);
});

test("projectId must match the compact identifier format, not free text", () => {
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "not a valid id!", projectName: "ok" } })), CcSummaryError);
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "../etc/passwd", projectName: "ok" } })), CcSummaryError);
});

test("counts must be non-negative safe integers within the bound", () => {
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: "ok", changedFileCount: -1 } })), CcSummaryError);
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: "ok", changedFileCount: 1.5 } })), CcSummaryError);
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: "ok", changedFileCount: 1_000_000 } })), CcSummaryError);
});

test("freshness must be one of the closed enum values", () => {
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: "ok", freshness: "very-fresh" } })), CcSummaryError);
  const result = normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: "ok", freshness: "stale" } }));
  assert.equal(result.context.freshness, "stale");
});

test("serviceStates is a bounded, closed array of {name, state}", () => {
  const result = normalizeCcSummaryRequest(validRequest({
    context: {
      projectId: "p1", projectName: "ok",
      serviceStates: [{ name: "api", state: "ok" }, { name: "worker", state: "degraded" }]
    }
  }));
  assert.equal(result.context.serviceStates.length, 2);
  assert.throws(() => normalizeCcSummaryRequest(validRequest({
    context: { projectId: "p1", projectName: "ok", serviceStates: [{ name: "api", state: "on-fire" }] }
  })), CcSummaryError);
  assert.throws(() => normalizeCcSummaryRequest(validRequest({
    context: { projectId: "p1", projectName: "ok", serviceStates: new Array(21).fill({ name: "x", state: "ok" }) }
  })), CcSummaryError);
});

test("progressPercent must be an integer between 0 and 100", () => {
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: "ok", progressPercent: 101 } })), CcSummaryError);
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: "ok", progressPercent: -1 } })), CcSummaryError);
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: { projectId: "p1", projectName: "ok", progressPercent: 50.5 } })), CcSummaryError);
});

test("a non-object request or context is rejected", () => {
  assert.throws(() => normalizeCcSummaryRequest(null), CcSummaryError);
  assert.throws(() => normalizeCcSummaryRequest("free text"), CcSummaryError);
  assert.throws(() => normalizeCcSummaryRequest(validRequest({ context: "not an object" })), CcSummaryError);
});
