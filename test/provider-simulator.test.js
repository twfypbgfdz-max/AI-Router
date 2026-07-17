import test from "node:test";
import assert from "node:assert/strict";
import { flavorRoleResult, providerRoleSummary } from "../orchestrator/provider-simulator.js";

const successBase = { exitCode: 0, issues: [], stderr: "", events: [], resultSummary: "neutral mock summary" };

test("each simulated profile produces a distinct, deterministic, local summary", () => {
  const claude = providerRoleSummary("claude-simulated", "planner");
  const openai = providerRoleSummary("openai-simulated", "executor");
  const gemini = providerRoleSummary("gemini-simulated", "planner");
  assert.notEqual(claude, openai);
  assert.notEqual(claude, gemini);
  assert.equal(claude, providerRoleSummary("claude-simulated", "planner"));
});

test("summaries never claim a real external model answered", () => {
  for (const id of ["claude-simulated", "openai-simulated", "gemini-simulated"]) {
    for (const role of ["planner", "executor", "reviewer", "synthesizer"]) {
      const text = providerRoleSummary(id, role);
      assert.match(text, /Lokale|lokal/);
      assert.equal(/Claude hat|ChatGPT hat|Gemini hat|OpenAI hat geantwortet/.test(text), false);
    }
  }
});

test("flavoring relabels a successful summary for simulated providers", () => {
  const flavored = flavorRoleResult(successBase, { providerId: "claude-simulated", modelId: "claude-general-sim", role: "planner" });
  assert.equal(flavored.simulated, true);
  assert.equal(flavored.providerId, "claude-simulated");
  assert.notEqual(flavored.resultSummary, "neutral mock summary");
  assert.match(flavored.resultSummary, /Claude-Profil-Simulation/);
});

test("the baseline mock provider passes through unchanged (behaviour preserved)", () => {
  const flavored = flavorRoleResult(successBase, { providerId: "mock-local", role: "executor" });
  assert.equal(flavored.resultSummary, "neutral mock summary");
});

test("failures and timeouts are not relabeled as success", () => {
  const failure = { exitCode: 1, issues: [], stderr: "Controlled executor failure.", events: [], resultSummary: null };
  const flavored = flavorRoleResult(failure, { providerId: "openai-simulated", role: "executor" });
  assert.equal(flavored.resultSummary, null);
  assert.equal(flavored.exitCode, 1);
  const timeout = flavorRoleResult({ timeout: true }, { providerId: "openai-simulated", role: "executor" });
  assert.equal(timeout.timeout, true);
});
