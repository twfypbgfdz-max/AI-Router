import test from "node:test";
import assert from "node:assert/strict";
import {
  createOpenAITextAdapter,
  openAITextAdapterInternals
} from "../orchestrator/provider-adapters/openai-text.js";
import {
  providerJsonResponse,
  providerTextPayload,
  TEST_API_KEY
} from "./text-response-helpers.js";

function adapterInput(overrides = {}) {
  return {
    instructions: "Fixed developer instructions.",
    question: "What is deterministic routing?",
    context: "Explicit context only.",
    maxOutputTokens: 800,
    signal: new AbortController().signal,
    ...overrides
  };
}

function adapterForPayload(payload) {
  return createOpenAITextAdapter({
    apiKey: TEST_API_KEY,
    model: "test-model",
    fetchImpl: async () => providerJsonResponse(payload)
  });
}

async function assertInvalidPayload(payload, reason) {
  await assert.rejects(
    adapterForPayload(payload).generateText(adapterInput()),
    (error) => error.code === "PROVIDER_RESPONSE_INVALID" && error.safeDetails?.reason === reason
  );
}

test("OpenAI adapter uses one fixed Responses API request with no tools, streaming, retry or client URL", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return providerJsonResponse(providerTextPayload("A deterministic answer."));
  };
  const adapter = createOpenAITextAdapter({
    apiKey: TEST_API_KEY,
    model: "server-side-test-model",
    fetchImpl
  });
  const input = adapterInput();
  const result = await adapter.generateText(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].url, openAITextAdapterInternals.endpoint);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.signal, input.signal);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TEST_API_KEY}`);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ["input", "instructions", "max_output_tokens", "model", "store"]);
  assert.equal(body.model, "server-side-test-model");
  assert.equal(body.max_output_tokens, 800);
  assert.equal(body.store, false);
  assert.deepEqual(body.input.map((message) => message.role), ["user", "user"]);
  assert.equal(body.input[0].content[0].text, "What is deterministic routing?");
  assert.equal(body.input[1].content[0].text, "Explicit context only.");
  for (const field of ["tools", "functions", "function_call", "stream", "previous_response_id"]) {
    assert.equal(Object.hasOwn(body, field), false);
  }
  assert.deepEqual(result, {
    text: "A deterministic answer.",
    usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 }
  });
});

test("reasoning output before one assistant text message is accepted", async () => {
  const payload = providerTextPayload("Answer after passive reasoning.");
  payload.output.unshift({
    type: "reasoning",
    status: null,
    summary: [],
    encrypted_content: "opaque-fake-test-metadata"
  });
  const result = await adapterForPayload(payload).generateText(adapterInput());
  assert.equal(result.text, "Answer after passive reasoning.");
});

test("safe response metadata and empty text metadata arrays are accepted without trusting convenience text", async () => {
  const payload = providerTextPayload("Validated message text.");
  payload.status = "completed";
  payload.metadata = { category: "fake-test" };
  payload.output_text = "Unvalidated convenience text.";
  payload.output[0].status = "completed";
  payload.output[0].content[0].logprobs = [];
  const result = await adapterForPayload(payload).generateText(adapterInput());
  assert.equal(result.text, "Validated message text.");
});

test("tool call plus text is rejected fail-closed", async () => {
  const payload = providerTextPayload("Text must not override a tool call.");
  payload.output.unshift({ type: "web_search_call", status: "completed" });
  await assertInvalidPayload(payload, "action_structure_detected");
});

test("function call output is rejected fail-closed", async () => {
  await assertInvalidPayload(
    { output: [{ type: "function_call", name: "unsafe", arguments: "{}" }] },
    "action_structure_detected"
  );
});

test("two assistant text messages are rejected as competing outputs", async () => {
  const first = providerTextPayload("First answer.").output[0];
  const second = providerTextPayload("Second answer.").output[0];
  await assertInvalidPayload({ output: [first, second] }, "multiple_text_outputs");
});

test("empty assistant text is rejected", async () => {
  await assertInvalidPayload(providerTextPayload("   "), "empty_provider_output");
});

test("unknown action-like output types are rejected fail-closed", async () => {
  const payload = providerTextPayload("Text must not override an unknown action.");
  payload.output.unshift({ type: "browser_navigation_action", status: "completed" });
  await assertInvalidPayload(payload, "action_structure_detected");
});

test("unknown non-message output types remain rejected", async () => {
  const payload = providerTextPayload("Text must not override an unknown item.");
  payload.output.unshift({ type: "future_metadata_item", status: "completed" });
  await assertInvalidPayload(payload, "unknown_output_item");
});

test("non-text content and actionable annotations remain rejected", async () => {
  const structures = [
    { output: [{ type: "computer_call", action: { type: "click" } }] },
    { output: [{ type: "message", role: "assistant", content: [{ type: "output_image", image_url: "x" }] }] },
    { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer", annotations: [{ type: "url_citation" }] }] }] },
    { ...providerTextPayload("Answer"), function_call: { name: "shell", arguments: "{}" } }
  ];
  for (const payload of structures) {
    const adapter = createOpenAITextAdapter({
      apiKey: TEST_API_KEY,
      model: "test-model",
      fetchImpl: async () => providerJsonResponse(payload)
    });
    await assert.rejects(adapter.generateText(adapterInput()), { code: "PROVIDER_RESPONSE_INVALID" });
  }
});

test("provider failures are generic, raw bodies are not parsed or exposed, and no retry occurs", async () => {
  let calls = 0;
  const response = providerJsonResponse({ raw: "RAW_PROVIDER_ERROR_MARKER" }, { status: 500 });
  const adapter = createOpenAITextAdapter({
    apiKey: TEST_API_KEY,
    model: "test-model",
    fetchImpl: async () => {
      calls += 1;
      return response;
    }
  });
  let caught;
  try {
    await adapter.generateText(adapterInput());
  } catch (error) {
    caught = error;
  }
  assert.equal(calls, 1);
  assert.equal(caught.code, "PROVIDER_UNAVAILABLE");
  assert.equal(String(caught.message).includes("RAW_PROVIDER_ERROR_MARKER"), false);
});

test("the mandatory AbortSignal reaches fetch and abort errors remain stable", async () => {
  let observedSignal;
  const fetchImpl = (_url, { signal }) => {
    observedSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), {
        once: true
      });
    });
  };
  const controller = new AbortController();
  const adapter = createOpenAITextAdapter({ apiKey: TEST_API_KEY, model: "test-model", fetchImpl });
  const pending = adapter.generateText(adapterInput({ signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, { code: "PROVIDER_TIMEOUT" });
  assert.equal(observedSignal, controller.signal);
  await assert.rejects(
    adapter.generateText({ instructions: "x", question: "y", context: null, maxOutputTokens: 800 }),
    { code: "INTERNAL_ERROR" }
  );
});

test("invalid provider JSON, excessive body size and invalid usage metadata fail closed", async () => {
  const invalidJsonAdapter = createOpenAITextAdapter({
    apiKey: TEST_API_KEY,
    model: "test-model",
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => "{"
    })
  });
  await assert.rejects(invalidJsonAdapter.generateText(adapterInput()), { code: "PROVIDER_RESPONSE_INVALID" });

  const oversizedAdapter = createOpenAITextAdapter({
    apiKey: TEST_API_KEY,
    model: "test-model",
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => "1048577" },
      body: { cancel: async () => {} },
      text: async () => ""
    })
  });
  await assert.rejects(oversizedAdapter.generateText(adapterInput()), { code: "PROVIDER_RESPONSE_INVALID" });

  const usageAdapter = createOpenAITextAdapter({
    apiKey: TEST_API_KEY,
    model: "test-model",
    fetchImpl: async () => providerJsonResponse(providerTextPayload("Answer", {
      input_tokens: "100",
      output_tokens: 20,
      total_tokens: 120
    }))
  });
  await assert.rejects(usageAdapter.generateText(adapterInput()), { code: "PROVIDER_RESPONSE_INVALID" });
});
