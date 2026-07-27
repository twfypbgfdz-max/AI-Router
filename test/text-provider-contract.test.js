import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTextProviderAdapter,
  isTextProviderAdapter
} from "../orchestrator/text-provider-contract.js";
import { createOllamaTextAdapter } from "../orchestrator/provider-adapters/ollama-text.js";
import { createOpenAITextAdapter } from "../orchestrator/provider-adapters/openai-text.js";
import { TEST_API_KEY } from "./text-response-helpers.js";

test("both the OpenAI and Ollama adapters satisfy the shared text-provider interface", () => {
  const openai = createOpenAITextAdapter({ apiKey: TEST_API_KEY, model: "test-model", fetchImpl: async () => {} });
  const ollama = createOllamaTextAdapter({ model: "qwen2.5:7b-instruct", fetchImpl: async () => {} });
  assert.equal(isTextProviderAdapter(openai), true);
  assert.equal(isTextProviderAdapter(ollama), true);
  assert.equal(assertTextProviderAdapter(openai), openai);
  assert.equal(assertTextProviderAdapter(ollama), ollama);
});

test("objects without generateText are rejected", () => {
  assert.equal(isTextProviderAdapter({}), false);
  assert.equal(isTextProviderAdapter(null), false);
  assert.throws(() => assertTextProviderAdapter({}), { code: "INTERNAL_ERROR" });
});
