import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { adaptCockpitSimulationRequest, adaptRouterResponseForCockpit } from "../orchestrator/cockpit-router-adapter.js";
import { processRouterRequest } from "../orchestrator/router-service.js";

const cockpitRequest = {
  schemaVersion: 1,
  mode: "simulate",
  execute: false,
  type: "route.recommendation",
  request: "Cockpit-Projektstatus zusammenfassen",
  requestedCapability: "simulate"
};

function isCurrentCockpitSimulation(value) {
  const keys = ["schemaVersion", "mode", "label", "request", "intent", "route", "target", "reason", "risk", "proposedAction", "executionStatus", "executed", "generatedAt"];
  return value && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)) &&
    value.schemaVersion === 1 && value.mode === "simulate" && value.label === "Simulation" &&
    ["codex", "mock"].includes(value.route) && value.risk === "low" && value.executed === false &&
    value.executionStatus === "never_executed" && Number.isFinite(Date.parse(value.generatedAt));
}

test("the current Cockpit request maps losslessly into the canonical safe request", () => {
  const value = adaptCockpitSimulationRequest(cockpitRequest, { requestId: "req_cockpit", now: () => new Date("2026-07-19T10:00:00.000Z") });
  assert.equal(value.schemaVersion, "2.0");
  assert.equal(value.requestId, "req_cockpit");
  assert.equal(value.source, "cockpit");
  assert.equal(value.mode, "simulation");
  assert.equal(value.input.content, cockpitRequest.request);
  assert.equal(value.options.allowActions, false);
  assert.equal(value.constraints.forbiddenCapabilities.includes("execute"), true);
});

test("the central core projects a response accepted by the current Cockpit mock assumptions", async () => {
  const output = await processRouterRequest(cockpitRequest, { now: () => new Date("2026-07-19T10:00:00.000Z") });
  assert.equal(isCurrentCockpitSimulation(output), true);
  assert.equal(output.intent, "project_status_summary");
  assert.equal(output.route, "codex");
  assert.equal(output.reason, "Die Anfrage bezieht sich auf eine sichere Cockpit-Vorschau.");
  assert.equal(JSON.stringify(output).includes("action\":"), false);
});

test("the compatibility layer contains no execution or fallback decision path", async () => {
  for (const input of [
    { ...cockpitRequest, execute: true },
    { ...cockpitRequest, mode: "execute" },
    { ...cockpitRequest, requestedCapability: "git.push" },
    { ...cockpitRequest, targetUrl: "https://example.test" }
  ]) {
    const output = await processRouterRequest(input);
    assert.equal(output.status, "failed");
    assert.equal(output.simulation, null);
    assert.equal(output.meta.executionEnabled, false);
  }
});

test("published routing schemas are parseable and encode the non-executing state model", async () => {
  const requestSchema = JSON.parse(await fs.readFile(new URL("../schemas/router-request-v2.json", import.meta.url), "utf8"));
  const responseSchema = JSON.parse(await fs.readFile(new URL("../schemas/router-response-v2.json", import.meta.url), "utf8"));
  assert.deepEqual(requestSchema.properties.mode.enum, ["recommendation", "simulation"]);
  assert.deepEqual(responseSchema.properties.status.enum, ["recommended", "simulated", "rejected", "failed"]);
  assert.equal(responseSchema.properties.meta.properties.executionEnabled.const, false);
  assert.equal(responseSchema.$defs.simulation.properties.executed.const, false);
  assert.equal(responseSchema.$defs.simulation.properties.executionStatus.const, "never_executed");
});
