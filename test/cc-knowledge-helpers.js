import { EventEmitter } from "node:events";

export const TEST_CC_TOKEN = "test-cc-knowledge-service-token-0123456789abcdef";
export const TEST_INTERNAL_TOKEN = "test-internal-service-token-0123456789abcdef";
export const MODEL = "qwen2.5:7b-instruct";

export function ccKnowledgeEnv(overrides = {}) {
  return {
    AI_ROUTER_CC_TOKEN: TEST_CC_TOKEN,
    AI_ROUTER_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    AI_ROUTER_OLLAMA_MODEL: MODEL,
    AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "bge-m3:latest",
    AI_ROUTER_OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    ...overrides
  };
}

export function validKnowledgeBody(overrides = {}) {
  return {
    schemaVersion: "1.0",
    question: "Darf der AI-Router eigenständig riskante Aktionen ausführen?",
    ...overrides
  };
}

export function knowledgeContext(overrides = {}) {
  return { projectId: "ai-router", projectName: "AI-Router", branch: "dev", clean: true, ...overrides };
}

// Mirrors the shape retrieveKnowledge actually produces, including the
// authority metadata joined on there (P1-A3). Defaults describe a current
// passage of an Accepted decision, matching the sourceDoc below.
export function ragResult(overrides = {}) {
  return {
    sourceDoc: "10_Apps/90_Entscheidungen/DEC-001.md",
    section: "3.3 AI-Router",
    docStatus: "Accepted",
    docVersion: "1.1",
    similarity: 0.9,
    freshness: "fresh",
    informationClass: "architecture_rule",
    reviewedAt: null,
    sectionValidity: "current",
    snippet: "Der AI-Router empfiehlt und vermittelt, führt aber keine folgenreichen Aktionen autonom aus.",
    ...overrides
  };
}

export function structuredAdapter({ answer = "Der AI-Router führt keine folgenreichen Aktionen autonom aus. [K1]", citedSources = ["K1"] } = {}) {
  const calls = [];
  return {
    adapter: {
      async generateText(input) {
        calls.push(input);
        return {
          text: JSON.stringify({ answer, citedSources }),
          usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 }
        };
      }
    },
    calls
  };
}

export function textAdapter(text) {
  return { async generateText() { return { text, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }; } };
}

// A minimal, correctly-behaving fake HTTP request/response pair for
// exercising createCcKnowledgeHandler directly, without a real network
// listener. Emits "data"/"end" asynchronously so readJsonBody's stream-based
// reader (which does not special-case a pre-set request.body) actually
// resolves.
export function fakeExchange(body, { headers = {}, method = "POST" } = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.headers = { "content-type": "application/json", authorization: `Bearer ${TEST_CC_TOKEN}`, ...headers };
  request.socket = new EventEmitter();
  queueMicrotask(() => {
    request.emit("data", JSON.stringify(body));
    request.emit("end");
  });

  const response = new EventEmitter();
  response.headers = new Map();
  response.statusCode = 200;
  response.writableEnded = false;
  response.destroyed = false;
  response.body = "";
  response.setHeader = (name, value) => response.headers.set(String(name).toLowerCase(), String(value));
  response.getHeader = (name) => response.headers.get(String(name).toLowerCase());
  response.end = (value = "") => {
    response.body = String(value);
    response.writableEnded = true;
    response.emit("finish");
  };
  response.json = () => JSON.parse(response.body);
  return { request, response };
}
