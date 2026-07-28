import test from "node:test";
import assert from "node:assert/strict";
import {
  createOllamaTextAdapter,
  ollamaTextAdapterInternals
} from "../orchestrator/provider-adapters/ollama-text.js";
import { providerJsonResponse } from "./text-response-helpers.js";

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

function ollamaPayload(content = "A deterministic answer.", { promptEvalCount = 100, evalCount = 25 } = {}) {
  return {
    model: "qwen2.5:7b-instruct",
    created_at: "2026-07-27T15:00:00.000Z",
    message: { role: "assistant", content },
    done: true,
    done_reason: "stop",
    prompt_eval_count: promptEvalCount,
    eval_count: evalCount
  };
}

function adapterForPayload(payload) {
  return createOllamaTextAdapter({
    model: "qwen2.5:7b-instruct",
    fetchImpl: async () => providerJsonResponse(payload)
  });
}

async function assertInvalidPayload(payload, reason) {
  await assert.rejects(
    adapterForPayload(payload).generateText(adapterInput()),
    (error) => error.code === "PROVIDER_RESPONSE_INVALID" && error.safeDetails?.reason === reason
  );
}

test("Ollama adapter uses one fixed chat request against the configured base URL", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return providerJsonResponse(ollamaPayload("A deterministic answer."));
  };
  const adapter = createOllamaTextAdapter({ model: "qwen2.5:7b-instruct", fetchImpl });
  const input = adapterInput();
  const result = await adapter.generateText(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ollamaTextAdapterInternals.defaultBaseUrl}/api/chat`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.signal, input.signal);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ["messages", "model", "options", "stream"]);
  assert.equal(body.model, "qwen2.5:7b-instruct");
  assert.equal(body.stream, false);
  assert.equal(body.options.num_predict, 800);
  assert.deepEqual(body.messages.map((message) => message.role), ["system", "user", "user"]);
  assert.equal(body.messages[1].content, "What is deterministic routing?");
  assert.equal(body.messages[2].content, "Explicit context only.");
  assert.deepEqual(result, {
    text: "A deterministic answer.",
    usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 }
  });
});

test("a custom base URL is respected and trailing slashes are stripped", async () => {
  const calls = [];
  const adapter = createOllamaTextAdapter({
    model: "qwen2.5:7b-instruct",
    baseUrl: "http://localhost:11500/",
    fetchImpl: async (url) => { calls.push(url); return providerJsonResponse(ollamaPayload("Answer.")); }
  });
  await adapter.generateText(adapterInput());
  assert.equal(calls[0], "http://localhost:11500/api/chat");
});

test("no context omits the second user message", async () => {
  const calls = [];
  const adapter = createOllamaTextAdapter({
    model: "qwen2.5:7b-instruct",
    fetchImpl: async (url, options) => { calls.push(options); return providerJsonResponse(ollamaPayload("Answer.")); }
  });
  await adapter.generateText(adapterInput({ context: null }));
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(body.messages.map((message) => message.role), ["system", "user"]);
});

test("an incomplete response (done: false) is rejected fail-closed", async () => {
  const payload = ollamaPayload("Partial answer.");
  payload.done = false;
  await assertInvalidPayload(payload, "provider_response_incomplete");
});

test("tool calls in the response are rejected fail-closed", async () => {
  const payload = ollamaPayload("Text must not override a tool call.");
  payload.tool_calls = [{ function: { name: "shell", arguments: "{}" } }];
  await assertInvalidPayload(payload, "action_structure_detected");
});

test("unexpected message fields are rejected fail-closed", async () => {
  const payload = ollamaPayload("Answer.");
  payload.message.images = ["not-supported"];
  await assertInvalidPayload(payload, "action_structure_detected");
});

test("a non-assistant role is rejected", async () => {
  const payload = ollamaPayload("Answer.");
  payload.message.role = "tool";
  await assertInvalidPayload(payload, "non_text_provider_output");
});

test("empty assistant text is rejected", async () => {
  await assertInvalidPayload(ollamaPayload("   "), "empty_provider_output");
});

test("invalid usage metadata fails closed", async () => {
  const payload = ollamaPayload("Answer.");
  payload.prompt_eval_count = "100";
  await assertInvalidPayload(payload, "usage_metadata_invalid");
});

test("missing usage metadata yields null totals instead of failing", async () => {
  const payload = ollamaPayload("Answer.");
  delete payload.prompt_eval_count;
  delete payload.eval_count;
  const result = await adapterForPayload(payload).generateText(adapterInput());
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
});

test("provider HTTP failures are generic and raw bodies are not exposed", async () => {
  let calls = 0;
  const response = providerJsonResponse({ error: "RAW_PROVIDER_ERROR_MARKER" }, { status: 500 });
  const adapter = createOllamaTextAdapter({
    model: "qwen2.5:7b-instruct",
    fetchImpl: async () => { calls += 1; return response; }
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

test("Ollama being unreachable (connection refused) surfaces as PROVIDER_UNAVAILABLE", async () => {
  const adapter = createOllamaTextAdapter({
    model: "qwen2.5:7b-instruct",
    fetchImpl: async () => {
      const error = new TypeError("fetch failed");
      error.cause = { code: "ECONNREFUSED" };
      throw error;
    }
  });
  await assert.rejects(adapter.generateText(adapterInput()), {
    code: "PROVIDER_UNAVAILABLE",
    safeDetails: { reason: "provider_network_error" }
  });
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
  const adapter = createOllamaTextAdapter({ model: "qwen2.5:7b-instruct", fetchImpl });
  const pending = adapter.generateText(adapterInput({ signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, { code: "PROVIDER_TIMEOUT" });
  assert.equal(observedSignal, controller.signal);
  await assert.rejects(
    adapter.generateText({ instructions: "x", question: "y", context: null, maxOutputTokens: 800 }),
    { code: "INTERNAL_ERROR" }
  );
});

test("invalid provider JSON and excessive body size fail closed", async () => {
  const invalidJsonAdapter = createOllamaTextAdapter({
    model: "qwen2.5:7b-instruct",
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => "{"
    })
  });
  await assert.rejects(invalidJsonAdapter.generateText(adapterInput()), { code: "PROVIDER_RESPONSE_INVALID" });

  const oversizedAdapter = createOllamaTextAdapter({
    model: "qwen2.5:7b-instruct",
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => "1048577" },
      body: { cancel: async () => {} },
      text: async () => ""
    })
  });
  await assert.rejects(oversizedAdapter.generateText(adapterInput()), { code: "PROVIDER_RESPONSE_INVALID" });
});

test("every request rejects redirects explicitly and a redirect is surfaced as a distinct, safe reason", async () => {
  const calls = [];
  const adapter = createOllamaTextAdapter({
    model: "qwen2.5:7b-instruct",
    fetchImpl: async (url, options) => {
      calls.push(options);
      const error = new TypeError("fetch failed");
      error.cause = new Error("unexpected redirect");
      throw error;
    }
  });
  assert.equal(calls.length, 0);
  let caught;
  try {
    await adapter.generateText(adapterInput());
  } catch (error) {
    caught = error;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, "error");
  assert.equal(caught.code, "PROVIDER_UNAVAILABLE");
  assert.equal(caught.safeDetails?.reason, "redirect_blocked");
});

test("a redirect target is never followed or contacted", async () => {
  const http = await import("node:http");
  const redirectCalls = { count: 0 };
  const redirectTarget = http.createServer((_req, res) => {
    redirectCalls.count += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(ollamaPayload("Should never be reached.")));
  });
  await new Promise((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
  const targetPort = redirectTarget.address().port;

  const redirectingServer = http.createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/` });
    res.end();
  });
  await new Promise((resolve) => redirectingServer.listen(0, "127.0.0.1", resolve));
  const sourcePort = redirectingServer.address().port;

  try {
    const adapter = createOllamaTextAdapter({
      model: "qwen2.5:7b-instruct",
      baseUrl: `http://127.0.0.1:${sourcePort}`
    });
    await assert.rejects(adapter.generateText(adapterInput()), {
      code: "PROVIDER_UNAVAILABLE",
      safeDetails: { reason: "redirect_blocked" }
    });
    assert.equal(redirectCalls.count, 0);
  } finally {
    await new Promise((resolve) => redirectingServer.close(resolve));
    await new Promise((resolve) => redirectTarget.close(resolve));
  }
});

test("missing configuration is rejected", () => {
  assert.throws(() => createOllamaTextAdapter({ fetchImpl: async () => {} }), { code: "PROVIDER_NOT_CONFIGURED" });
  assert.throws(() => createOllamaTextAdapter({ model: "" }), { code: "PROVIDER_NOT_CONFIGURED" });
});
