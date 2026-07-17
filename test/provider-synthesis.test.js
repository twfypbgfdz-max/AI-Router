import test from "node:test";
import assert from "node:assert/strict";
import { synthesizeProviderResults } from "../orchestrator/provider-synthesis.js";

const roleResults = [
  { role: "planner", providerId: "claude-simulated", simulated: true, summary: "Plan simuliert.", status: "succeeded" },
  { role: "executor", providerId: "openai-simulated", simulated: true, summary: "Umsetzung simuliert.", status: "succeeded" },
  { role: "reviewer", providerId: "claude-simulated", simulated: true, summary: "Prüfung simuliert.", status: "succeeded" },
  { role: "synthesizer", providerId: "mock-local", simulated: true, summary: "Zusammenführung simuliert.", status: "succeeded" }
];

test("synthesis reports providers, agreements, disagreements and a conclusion", () => {
  const s = synthesizeProviderResults({ workflowProfile: "specialist_chain", roleResults });
  assert.equal(s.simulated, true);
  assert.equal(s.workflowProfile, "specialist_chain");
  assert.deepEqual(s.providersUsed.sort(), ["claude-simulated", "mock-local", "openai-simulated"]);
  assert.ok(s.agreements.length >= 1);
  assert.ok(s.disagreements.length >= 1); // divergent profiles are surfaced honestly
  assert.equal(s.reviewStatus, "reviewed");
  assert.match(s.selectedConclusion, /Zusammenführung/);
});

test("without a reviewer, conflicting profiles raise uncertainty and recommend a review", () => {
  const noReviewer = roleResults.filter((r) => r.role !== "reviewer");
  const s = synthesizeProviderResults({ workflowProfile: "specialist_chain", roleResults: noReviewer, uncertainty: "low" });
  assert.equal(s.reviewStatus, "review_recommended");
  assert.equal(s.uncertainty, "high");
  assert.ok(s.warnings.length >= 1);
});

test("synthesis keeps no raw provider output or prompts, only bounded derived text", () => {
  const s = synthesizeProviderResults({ workflowProfile: "single_provider", roleResults: [{ role: "executor", providerId: "mock-local", simulated: true, summary: "x".repeat(5000), status: "succeeded" }] });
  assert.ok(s.selectedConclusion.length <= 400);
  assert.equal(s.disagreements.length, 0);
});
