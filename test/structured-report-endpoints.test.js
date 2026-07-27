import test from "node:test";
import assert from "node:assert/strict";
import { createTextResponseHandler } from "../orchestrator/text-response-handler.js";
import { createResponseMetadataLogger } from "../orchestrator/response-metadata-logger.js";
import { externalContext, fakeHttpExchange, textProviderEnv, validTextResponseRequest } from "./text-response-helpers.js";

function handlerWith({ forcedIntent, adapter, env = textProviderEnv(), logEntries = [] }) {
  return {
    handler: createTextResponseHandler({
      env,
      forcedIntent,
      adapterFactory: () => adapter,
      metadataLogger: createResponseMetadataLogger({ sink: (entry) => logEntries.push(entry) })
    }),
    logEntries
  };
}

test("the project-status endpoint forces its intent regardless of what the client sends", async () => {
  const calls = [];
  const adapter = {
    async generateText(input) {
      calls.push(input);
      return {
        text: JSON.stringify({ summary: "On track.", keyFacts: ["Green build."], openQuestions: [], risks: [] }),
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 }
      };
    }
  };
  const { handler } = handlerWith({ forcedIntent: "project_status_report", adapter });
  const exchange = fakeHttpExchange({
    body: validTextResponseRequest({
      intent: "writing",
      input: { type: "text", content: "Summarize the project." },
      context: externalContext({ content: "Repo at commit abc123, 322 tests passing." })
    })
  });
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 200);
  const body = exchange.response.json();
  assert.equal(body.route.name, "knowledge_query");
  assert.equal(body.answer.type, "structured_json");
  assert.deepEqual(body.answer.structured, {
    summary: "On track.",
    keyFacts: ["Green build."],
    openQuestions: [],
    risks: []
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].instructions, /exactly these top-level keys.*summary.*keyFacts.*openQuestions.*risks/s);
});

test("the git-changes endpoint forces its intent and validates the commits schema", async () => {
  const adapter = {
    async generateText() {
      return {
        text: JSON.stringify({
          summary: "Two commits added the Ollama provider.",
          commits: [{ ref: "abc123", description: "Add Ollama adapter." }],
          risks: ["Not load-tested yet."]
        }),
        usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 }
      };
    }
  };
  const { handler } = handlerWith({ forcedIntent: "git_change_report", adapter });
  const exchange = fakeHttpExchange({
    body: validTextResponseRequest({
      input: { type: "text", content: "Explain these commits." },
      context: externalContext({ content: "abc123 Add Ollama adapter\ndef456 Wire adapter into service" })
    })
  });
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 200);
  const body = exchange.response.json();
  assert.equal(body.route.name, "analysis");
  assert.equal(body.answer.structured.commits[0].ref, "abc123");
});

test("a malformed structured answer is rejected fail-closed and logged as failed, not answered", async () => {
  const adapter = { async generateText() { return { text: "not json", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }; } };
  const entries = [];
  const { handler, logEntries } = handlerWith({ forcedIntent: "project_status_report", adapter, logEntries: entries });
  const exchange = fakeHttpExchange({ body: validTextResponseRequest() });
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 502);
  assert.equal(exchange.response.json().error.code, "PROVIDER_RESPONSE_INVALID");
  assert.equal(logEntries.length, 1);
  assert.equal(logEntries[0].status, "failed");
  assert.equal(logEntries[0].errorCode, "PROVIDER_RESPONSE_INVALID");
});

test("a well-formed JSON answer with the wrong shape is still rejected fail-closed", async () => {
  const adapter = {
    async generateText() {
      return { text: JSON.stringify({ summary: "ok" }), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    }
  };
  const { handler } = handlerWith({ forcedIntent: "project_status_report", adapter });
  const exchange = fakeHttpExchange({ body: validTextResponseRequest() });
  await handler(exchange.request, exchange.response);
  assert.equal(exchange.response.statusCode, 502);
  assert.equal(exchange.response.json().error.code, "PROVIDER_RESPONSE_INVALID");
});
