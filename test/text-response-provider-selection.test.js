import test from "node:test";
import assert from "node:assert/strict";
import {
  loadTextResponseProviderId,
  loadOllamaTextProviderConfig,
  OLLAMA_TEXT_PROVIDER_ID,
  OLLAMA_TEXT_MODEL_ALIAS,
  OLLAMA_TEXT_DEFAULT_BASE_URL
} from "../orchestrator/text-response-config.js";
import { createTextResponseService } from "../orchestrator/text-response-service.js";
import { buildTextResponseSuccess } from "../orchestrator/text-response-response.js";
import { textProviderEnv, validTextResponseRequest } from "./text-response-helpers.js";

const now = () => new Date("2026-07-27T16:00:00.000Z");

test("AI_ROUTER_TEXT_PROVIDER selects the provider; default and unset both mean openai", () => {
  assert.equal(loadTextResponseProviderId({}), "openai");
  assert.equal(loadTextResponseProviderId({ AI_ROUTER_TEXT_PROVIDER: "" }), "openai");
  assert.equal(loadTextResponseProviderId({ AI_ROUTER_TEXT_PROVIDER: "OLLAMA" }), "ollama");
  assert.equal(loadTextResponseProviderId({ AI_ROUTER_TEXT_PROVIDER: "  ollama  " }), "ollama");
});

test("an unknown provider selection fails closed", () => {
  assert.throws(
    () => loadTextResponseProviderId({ AI_ROUTER_TEXT_PROVIDER: "anthropic" }),
    (error) => error.code === "PROVIDER_NOT_CONFIGURED" && error.safeDetails?.reason === "provider_selection_invalid"
  );
});

test("Ollama provider config has zero cost fields and a safe default base URL", () => {
  const config = loadOllamaTextProviderConfig({ AI_ROUTER_OLLAMA_MODEL: "qwen2.5:7b-instruct" });
  assert.equal(config.providerId, OLLAMA_TEXT_PROVIDER_ID);
  assert.equal(config.modelAlias, OLLAMA_TEXT_MODEL_ALIAS);
  assert.equal(config.baseUrl, OLLAMA_TEXT_DEFAULT_BASE_URL);
  assert.equal(config.inputUsdPerMillionTokens, 0);
  assert.equal(config.outputUsdPerMillionTokens, 0);
});

test("missing or invalid Ollama model/base URL configuration fails closed", () => {
  assert.throws(() => loadOllamaTextProviderConfig({}), { code: "PROVIDER_NOT_CONFIGURED" });
  assert.throws(
    () => loadOllamaTextProviderConfig({ AI_ROUTER_OLLAMA_MODEL: "ok-model", AI_ROUTER_OLLAMA_BASE_URL: "not-a-url" }),
    (error) => error.code === "PROVIDER_NOT_CONFIGURED" && error.safeDetails?.reason === "base_url_configuration_invalid"
  );
});

test("with no adapterFactory override, AI_ROUTER_TEXT_PROVIDER=ollama actually routes through the Ollama adapter", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { cancel: async () => {} },
      text: async () => JSON.stringify({
        message: { role: "assistant", content: "Routed through Ollama." },
        done: true,
        prompt_eval_count: 12,
        eval_count: 4
      })
    };
  };
  try {
    const env = textProviderEnv({ AI_ROUTER_TEXT_PROVIDER: "ollama", AI_ROUTER_OLLAMA_MODEL: "qwen2.5:7b-instruct" });
    const service = createTextResponseService({ env, now });
    const result = await service.respond(validTextResponseRequest(), { signal: new AbortController().signal });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${OLLAMA_TEXT_DEFAULT_BASE_URL}/api/chat`);
    assert.equal(result.answerText, "Routed through Ollama.");
    assert.equal(result.provider.providerId, OLLAMA_TEXT_PROVIDER_ID);
    const response = buildTextResponseSuccess(result);
    assert.equal(response.provider.providerId, OLLAMA_TEXT_PROVIDER_ID);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("with no AI_ROUTER_TEXT_PROVIDER set, the default remains openai even with no adapterFactory override", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { cancel: async () => {} },
      text: async () => JSON.stringify({
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Routed through OpenAI." }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      })
    };
  };
  try {
    const env = textProviderEnv();
    const service = createTextResponseService({ env, now });
    const result = await service.respond(validTextResponseRequest(), { signal: new AbortController().signal });
    assert.equal(called, true);
    assert.equal(result.answerText, "Routed through OpenAI.");
    assert.equal(result.provider.providerId, "openai-text-v1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
