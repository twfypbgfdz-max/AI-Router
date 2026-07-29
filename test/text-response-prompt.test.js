import test from "node:test";
import assert from "node:assert/strict";
import {
  GIT_CHANGE_REPORT_INSTRUCTIONS,
  KNOWLEDGE_ANSWER_INSTRUCTIONS,
  PROJECT_STATUS_REPORT_INSTRUCTIONS,
  READ_ONLY_TEXT_RESPONSE_INSTRUCTIONS,
  buildTextResponsePrompt
} from "../orchestrator/text-response-prompt.js";

test("knowledge_answer instructions require exactly one JSON object with answer and citedSources", () => {
  assert.match(KNOWLEDGE_ANSWER_INSTRUCTIONS, /exactly one JSON object/i);
  assert.match(KNOWLEDGE_ANSWER_INSTRUCTIONS, /answer \(string\), citedSources \(array of strings\)/);
});

test("knowledge_answer instructions forbid markdown code fences and extra prose", () => {
  assert.match(KNOWLEDGE_ANSWER_INSTRUCTIONS, /no markdown code fences/i);
  assert.match(KNOWLEDGE_ANSWER_INSTRUCTIONS, /no prose before or after it/i);
});

test("knowledge_answer instructions restrict citedSources to K1/K2/K3 and forbid invented sources", () => {
  assert.match(KNOWLEDGE_ANSWER_INSTRUCTIONS, /"K1", "K2" and "K3"/);
  assert.match(KNOWLEDGE_ANSWER_INSTRUCTIONS, /never a duplicate/i);
  assert.match(KNOWLEDGE_ANSWER_INSTRUCTIONS, /never an invented source/i);
});

test("knowledge_answer instructions explicitly allow an empty citedSources array for a context-only answer", () => {
  assert.match(KNOWLEDGE_ANSWER_INSTRUCTIONS, /empty array only when the answer is based solely on the current system state/i);
});

test("knowledge_answer instructions forbid tools, function calls and action objects", () => {
  assert.match(KNOWLEDGE_ANSWER_INSTRUCTIONS, /tools, function calls, action objects/i);
});

test("knowledge_answer instructions still include the shared read-only base instructions", () => {
  assert.ok(KNOWLEDGE_ANSWER_INSTRUCTIONS.includes(READ_ONLY_TEXT_RESPONSE_INSTRUCTIONS));
});

test("existing intent instructions (project_status_report, git_change_report) are unchanged", () => {
  assert.match(PROJECT_STATUS_REPORT_INSTRUCTIONS, /summary \(string\), keyFacts \(array of strings\)/);
  assert.match(GIT_CHANGE_REPORT_INSTRUCTIONS, /summary \(string\), commits \(array of objects/);
});

test("buildTextResponsePrompt selects the knowledge_answer instructions for that intent", () => {
  const prompt = buildTextResponsePrompt({ intent: "knowledge_answer", input: { content: "Frage?" }, context: null });
  assert.equal(prompt.instructions, KNOWLEDGE_ANSWER_INSTRUCTIONS);
  assert.equal(prompt.question, "Frage?");
});

test("buildTextResponsePrompt still falls back to the read-only instructions for a generic intent", () => {
  const prompt = buildTextResponsePrompt({ intent: "auto", input: { content: "Frage?" }, context: null });
  assert.equal(prompt.instructions, READ_ONLY_TEXT_RESPONSE_INSTRUCTIONS);
});
