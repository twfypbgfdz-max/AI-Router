import { EventEmitter } from "node:events";

export const TEST_INTERNAL_TOKEN = "test-internal-service-token-0123456789abcdef";
export const TEST_API_KEY = "sk-test-provider-key-0123456789abcdef";

export function textProviderEnv(overrides = {}) {
  return {
    AI_ROUTER_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    OPENAI_API_KEY: TEST_API_KEY,
    AI_ROUTER_OPENAI_MODEL: "test-openai-model",
    AI_ROUTER_OPENAI_INPUT_USD_PER_MILLION_TOKENS: "1",
    AI_ROUTER_OPENAI_OUTPUT_USD_PER_MILLION_TOKENS: "6",
    AI_ROUTER_MAX_COST_USD: "0.02",
    AI_ROUTER_PROVIDER_TIMEOUT_MS: "1000",
    AI_ROUTER_MAX_REQUESTS_PER_MINUTE: "10",
    AI_ROUTER_MAX_CONCURRENT_REQUESTS: "2",
    ...overrides
  };
}

export function validTextResponseRequest(overrides = {}) {
  return {
    schemaVersion: "1.0",
    requestId: "req_text_123",
    source: "internal_test",
    intent: "auto",
    input: { type: "text", content: "Explain deterministic routing." },
    ...overrides
  };
}

export function externalContext(overrides = {}) {
  return {
    type: "text",
    content: "The AI Router was checked at a known test commit.",
    containsPrivateData: false,
    privacyLevel: "external-provider-allowed",
    sourceLabel: "test-project-status",
    capturedAt: "2026-07-25T12:00:00.000Z",
    ...overrides
  };
}

export function successfulAdapter({ text = "A safe plain-text answer.", usage, truncated = false } = {}) {
  const calls = [];
  const adapter = {
    async generateText(input) {
      calls.push(input);
      return {
        text,
        usage: usage || { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
        truncated
      };
    }
  };
  return { adapter, calls };
}

export function fakeHttpExchange({
  method = "POST",
  headers = {
    authorization: `Bearer ${TEST_INTERNAL_TOKEN}`,
    "content-type": "application/json"
  },
  body = validTextResponseRequest()
} = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.headers = { ...headers };
  request.body = body;
  request.socket = new EventEmitter();

  const response = new EventEmitter();
  response.headers = new Map();
  response.statusCode = 200;
  response.writableEnded = false;
  response.destroyed = false;
  response.body = "";
  response.setHeader = (name, value) => response.headers.set(String(name).toLowerCase(), String(value));
  response.end = (value = "") => {
    response.body = String(value);
    response.writableEnded = true;
    response.emit("finish");
  };
  response.json = () => JSON.parse(response.body);
  return { request, response };
}

export function providerJsonResponse(payload, { status = 200, headers = {} } = {}) {
  const normalizedHeaders = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalizedHeaders.get(String(name).toLowerCase()) || null },
    body: { cancel: async () => {} },
    text: async () => JSON.stringify(payload)
  };
}

export function providerTextPayload(text = "Provider answer.", usage = { input_tokens: 100, output_tokens: 25, total_tokens: 125 }) {
  return {
    id: "resp_test",
    output: [
      {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }]
      }
    ],
    usage
  };
}
