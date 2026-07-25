import test from "node:test";
import assert from "node:assert/strict";
import { createTextResponseHandler } from "../orchestrator/text-response-handler.js";
import { createResponseMetadataLogger } from "../orchestrator/response-metadata-logger.js";
import {
  externalContext,
  fakeHttpExchange,
  successfulAdapter,
  TEST_INTERNAL_TOKEN,
  textProviderEnv,
  validTextResponseRequest
} from "./text-response-helpers.js";

function handlerWith({
  env = textProviderEnv(),
  adapter,
  logEntries = [],
  timingSafeEqualFn,
  now,
  totalTimeoutMs
} = {}) {
  const fallback = successfulAdapter();
  const selectedAdapter = adapter || fallback.adapter;
  const metadataLogger = createResponseMetadataLogger({ sink: (entry) => logEntries.push(entry) });
  return {
    handler: createTextResponseHandler({
      env,
      adapterFactory: () => selectedAdapter,
      metadataLogger,
      timingSafeEqualFn,
      now,
      totalTimeoutMs
    }),
    adapter: selectedAdapter,
    calls: fallback.calls,
    logEntries
  };
}

test("authentication fails closed for missing server configuration, missing headers and wrong tokens", async () => {
  const validAuthEnvironment = textProviderEnv();
  const missingAuthEnvironment = textProviderEnv();
  delete missingAuthEnvironment.AI_ROUTER_INTERNAL_TOKEN;

  const missingConfigExchange = fakeHttpExchange();
  await handlerWith({ env: missingAuthEnvironment }).handler(
    missingConfigExchange.request,
    missingConfigExchange.response
  );
  assert.equal(missingConfigExchange.response.statusCode, 503);
  assert.equal(missingConfigExchange.response.json().error.code, "AUTH_NOT_CONFIGURED");

  const missingTokenExchange = fakeHttpExchange({ headers: { "content-type": "application/json" } });
  await handlerWith({ env: validAuthEnvironment }).handler(
    missingTokenExchange.request,
    missingTokenExchange.response
  );
  assert.equal(missingTokenExchange.response.statusCode, 403);
  assert.equal(missingTokenExchange.response.json().error.code, "AUTH_REQUIRED");

  const wrongTokenExchange = fakeHttpExchange({
    headers: {
      authorization: "Bearer wrong-internal-service-token-0123456789abcdef",
      "content-type": "application/json"
    }
  });
  await handlerWith({ env: validAuthEnvironment }).handler(
    wrongTokenExchange.request,
    wrongTokenExchange.response
  );
  assert.equal(wrongTokenExchange.response.statusCode, 403);
  assert.equal(wrongTokenExchange.response.json().error.code, "AUTH_INVALID");
});

test("valid authentication uses the timing-safe comparison path and never logs the token", async () => {
  let comparisons = 0;
  const entries = [];
  const timingSafeEqualFn = (actual, expected) => {
    comparisons += 1;
    return actual.equals(expected);
  };
  const exchange = fakeHttpExchange();
  await handlerWith({ logEntries: entries, timingSafeEqualFn }).handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 200);
  assert.equal(comparisons, 1);
  assert.equal(JSON.stringify(entries).includes(TEST_INTERNAL_TOKEN), false);
});

test("rate limiting rejects before a second adapter call and returns Retry-After", async () => {
  const { adapter, calls } = successfulAdapter();
  const { handler } = handlerWith({
    env: textProviderEnv({ AI_ROUTER_MAX_REQUESTS_PER_MINUTE: "1" }),
    adapter
  });
  const first = fakeHttpExchange();
  await handler(first.request, first.response);
  assert.equal(first.response.statusCode, 200);
  const second = fakeHttpExchange({ body: validTextResponseRequest({ requestId: "req_rate_2" }) });
  await handler(second.request, second.response);
  assert.equal(second.response.statusCode, 429);
  assert.equal(second.response.json().error.code, "RATE_LIMITED");
  assert.ok(Number(second.response.headers.get("retry-after")) >= 1);
  assert.equal(calls.length, 1);
});

test("concurrency limiting has no queue and releases after completion", async () => {
  let resolveFirst;
  let calls = 0;
  const adapter = {
    generateText() {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveFirst = () => resolve({
            text: "First response.",
            usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }
          });
        });
      }
      return Promise.resolve({
        text: "Later response.",
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }
      });
    }
  };
  const { handler } = handlerWith({
    env: textProviderEnv({ AI_ROUTER_MAX_CONCURRENT_REQUESTS: "1" }),
    adapter
  });
  const first = fakeHttpExchange({ body: validTextResponseRequest({ requestId: "req_concurrent_1" }) });
  const firstPending = handler(first.request, first.response);
  await new Promise((resolve) => setImmediate(resolve));

  const second = fakeHttpExchange({ body: validTextResponseRequest({ requestId: "req_concurrent_2" }) });
  await handler(second.request, second.response);
  assert.equal(second.response.statusCode, 429);
  assert.equal(second.response.json().error.code, "CONCURRENCY_LIMITED");
  assert.equal(calls, 1);

  resolveFirst();
  await firstPending;
  const third = fakeHttpExchange({ body: validTextResponseRequest({ requestId: "req_concurrent_3" }) });
  await handler(third.request, third.response);
  assert.equal(third.response.statusCode, 200);
  assert.equal(calls, 2);
});

test("validation and security rejections do not call the adapter", async () => {
  const { adapter, calls } = successfulAdapter();
  const { handler } = handlerWith({ adapter });
  const privateExchange = fakeHttpExchange({
    body: validTextResponseRequest({ context: externalContext({ containsPrivateData: true }) })
  });
  await handler(privateExchange.request, privateExchange.response);
  assert.equal(privateExchange.response.statusCode, 403);
  assert.equal(privateExchange.response.json().error.reasonCode, "private_context");

  const clientProvider = fakeHttpExchange({
    body: validTextResponseRequest({ provider: "openai", model: "client-model", url: "https://client.invalid" })
  });
  await handler(clientProvider.request, clientProvider.response);
  assert.equal(clientProvider.response.statusCode, 422);
  assert.equal(clientProvider.response.json().error.code, "VALIDATION_FAILED");
  assert.equal(calls.length, 0);
});

test("body limit and transport checks happen before provider work", async () => {
  const { adapter, calls } = successfulAdapter();
  const { handler } = handlerWith({ adapter });
  const oversized = fakeHttpExchange({
    headers: {
      authorization: `Bearer ${TEST_INTERNAL_TOKEN}`,
      "content-type": "application/json",
      "content-length": "16385"
    }
  });
  await handler(oversized.request, oversized.response);
  assert.equal(oversized.response.statusCode, 413);
  assert.equal(oversized.response.json().error.code, "INPUT_TOO_LARGE");

  const browser = fakeHttpExchange({
    headers: {
      authorization: `Bearer ${TEST_INTERNAL_TOKEN}`,
      "content-type": "application/json",
      origin: "https://browser.invalid"
    }
  });
  await handler(browser.request, browser.response);
  assert.equal(browser.response.statusCode, 403);
  assert.equal(browser.response.json().error.reasonCode, "browser_origin_blocked");
  assert.equal(calls.length, 0);
});

test("client disconnect aborts the active provider signal and frees concurrency", async () => {
  let firstSignal;
  let calls = 0;
  const adapter = {
    generateText({ signal }) {
      calls += 1;
      if (calls === 1) {
        firstSignal = signal;
        return new Promise(() => {});
      }
      return Promise.resolve({
        text: "Recovered.",
        usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 }
      });
    }
  };
  const { handler } = handlerWith({
    env: textProviderEnv({ AI_ROUTER_MAX_CONCURRENT_REQUESTS: "1" }),
    adapter
  });
  const first = fakeHttpExchange({ body: validTextResponseRequest({ requestId: "req_disconnect_1" }) });
  const pending = handler(first.request, first.response);
  await new Promise((resolve) => setImmediate(resolve));
  first.request.socket.emit("close");
  await pending;
  assert.equal(firstSignal.aborted, true);

  const second = fakeHttpExchange({ body: validTextResponseRequest({ requestId: "req_disconnect_2" }) });
  await handler(second.request, second.response);
  assert.equal(second.response.statusCode, 200);
  assert.equal(calls, 2);
});

test("the total request timeout aborts provider work even when the provider timeout is longer", async () => {
  let observedSignal;
  const adapter = {
    generateText({ signal }) {
      observedSignal = signal;
      return new Promise(() => {});
    }
  };
  const { handler } = handlerWith({
    env: textProviderEnv({ AI_ROUTER_PROVIDER_TIMEOUT_MS: "1000" }),
    adapter,
    totalTimeoutMs: 10
  });
  const exchange = fakeHttpExchange();
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 504);
  assert.equal(exchange.response.json().error.reasonCode, "total_timeout");
  assert.equal(observedSignal.aborted, true);
});

test("allowlisted metadata logging excludes question, context, answer, keys, tokens and provider errors", async () => {
  const markers = {
    question: "QUESTION_MARKER_91",
    context: "CONTEXT_MARKER_92",
    answer: "ANSWER_MARKER_93",
    apiKey: "sk-API_KEY_MARKER_94-0123456789",
    token: "SERVICE_TOKEN_MARKER_95-0123456789abcdef",
    providerError: "PROVIDER_ERROR_MARKER_96"
  };
  const entries = [];
  const env = textProviderEnv({
    OPENAI_API_KEY: markers.apiKey,
    AI_ROUTER_INTERNAL_TOKEN: markers.token
  });
  const successAdapter = {
    async generateText() {
      return {
        text: markers.answer,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
      };
    }
  };
  const success = fakeHttpExchange({
    headers: {
      authorization: `Bearer ${markers.token}`,
      "content-type": "application/json"
    },
    body: validTextResponseRequest({
      input: { type: "text", content: markers.question },
      context: externalContext({ content: markers.context })
    })
  });
  await handlerWith({ env, adapter: successAdapter, logEntries: entries }).handler(success.request, success.response);
  assert.equal(success.response.statusCode, 200);

  const failureEntries = [];
  const failureAdapter = {
    async generateText() {
      throw new Error(markers.providerError);
    }
  };
  const failure = fakeHttpExchange({
    headers: {
      authorization: `Bearer ${markers.token}`,
      "content-type": "application/json"
    }
  });
  await handlerWith({ env, adapter: failureAdapter, logEntries: failureEntries }).handler(failure.request, failure.response);
  const rawLogs = JSON.stringify([...entries, ...failureEntries]);
  for (const marker of Object.values(markers)) assert.equal(rawLogs.includes(marker), false, marker);
  assert.equal(failure.response.body.includes(markers.providerError), false);
});
