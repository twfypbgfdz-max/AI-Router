import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCcKnowledgeHandler } from "../orchestrator/cc-knowledge-handler.js";
import { ccKnowledgeEnv, knowledgeContext, ragResult, structuredAdapter, textAdapter, validKnowledgeBody, TEST_CC_TOKEN } from "./cc-knowledge-helpers.js";

const ownsTemporaryDataDir = !process.env.AI_ROUTER_DATA_DIR;
if (ownsTemporaryDataDir) process.env.AI_ROUTER_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-cc-knowledge-tests-"));
const { createRouterServer } = await import("../orchestrator/server.js");
test.after(async () => { if (ownsTemporaryDataDir) await fs.rm(process.env.AI_ROUTER_DATA_DIR, { recursive: true, force: true }); });

async function withServer(run, { handlerOptions = {}, ...serverOptions } = {}) {
  const ccKnowledgeHandler = createCcKnowledgeHandler({
    env: ccKnowledgeEnv(),
    totalTimeoutMs: 2_000,
    retrieveKnowledgeFn: async () => ({ knowledgeState: "available", results: [ragResult()] }),
    ...handlerOptions
  });
  const server = createRouterServer({ eventLogger: { log: async () => {} }, ccKnowledgeHandler, ...serverOptions });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }); }
}

function post(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/api/v1/cc/knowledge`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CC_TOKEN}`, ...headers },
    body: JSON.stringify(body)
  });
}

// --- Transport: auth, origin, method --------------------------------------

test("a valid CC token with context and knowledge produces state ok", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.state, "ok");
    assert.equal(body.systemContextState, "available");
    assert.equal(body.knowledgeState, "available");
  }, { handlerOptions: { adapterFactory: () => structuredAdapter().adapter } });
});

test("a missing Authorization header is rejected as AUTH_REQUIRED (401)", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/cc/knowledge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validKnowledgeBody())
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "AUTH_REQUIRED");
  });
});

test("a wrong CC token is rejected as AUTH_INVALID (401)", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody(), { authorization: "Bearer wrong-token-0123456789abcdefghijk" });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "AUTH_INVALID");
  });
});

test("missing server-side CC token configuration fails closed as AUTH_NOT_CONFIGURED (503)", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody());
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "AUTH_NOT_CONFIGURED");
  }, { handlerOptions: { env: ccKnowledgeEnv({ AI_ROUTER_CC_TOKEN: undefined }) } });
});

test("a browser Origin header is rejected before authentication", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody(), { origin: "https://evil.example.com" });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "ORIGIN_NOT_ALLOWED");
  });
});

test("a non-POST method is rejected as METHOD_NOT_ALLOWED (405) with an Allow header", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/cc/knowledge`, { method: "GET", headers: { authorization: `Bearer ${TEST_CC_TOKEN}` } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  });
});

test("unknown request fields are rejected as a VALIDATION_FAILED transport failure (422)", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, { ...validKnowledgeBody(), minSimilarity: 0.1 });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  });
});

test("a request larger than the configured limit is rejected before any Ollama contact", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, { schemaVersion: "1.0", question: "x".repeat(20_000) });
    assert.equal(response.status, 422);
  });
});

// --- Data-basis matrix -----------------------------------------------------

test("context and knowledge both present, fresh index: state ok", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    const body = await response.json();
    assert.equal(body.state, "ok");
  }, { handlerOptions: { adapterFactory: () => structuredAdapter().adapter } });
});

test("only context present (no RAG match): state partial, empty citedSources allowed", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    const body = await response.json();
    assert.equal(body.state, "partial");
    assert.equal(body.systemContextState, "available");
    assert.equal(body.knowledgeState, "no_match");
    assert.deepEqual(body.sources, []);
  }, {
    handlerOptions: {
      adapterFactory: () => structuredAdapter({ answer: "Laut aktuellem Systemzustand ist der Branch dev.", citedSources: [] }).adapter,
      retrieveKnowledgeFn: async () => ({ knowledgeState: "no_match", results: [] })
    }
  });
});

test("only RAG knowledge present (no context): state partial, a source id is required", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody());
    const body = await response.json();
    assert.equal(body.state, "partial");
    assert.equal(body.systemContextState, "unavailable");
    assert.equal(body.sources.length, 1);
  }, { handlerOptions: { adapterFactory: () => structuredAdapter().adapter } });
});

test("only RAG knowledge present, model omits the required source id: fail-closed", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody());
    const body = await response.json();
    assert.equal(body.state, "unavailable");
    assert.ok(body.warnings.includes("model_source_validation_failed"));
  }, { handlerOptions: { adapterFactory: () => structuredAdapter({ citedSources: [] }).adapter } });
});

test("no context and no RAG match: unavailable, no Ollama call is made", async () => {
  let called = false;
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody());
    const body = await response.json();
    assert.equal(body.state, "unavailable");
    assert.deepEqual(body.warnings, ["no_context_no_knowledge"]);
    assert.equal(body.answer, null);
    assert.equal(called, false);
  }, {
    handlerOptions: {
      adapterFactory: () => ({ async generateText() { called = true; return { text: "{}", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; } }),
      retrieveKnowledgeFn: async () => ({ knowledgeState: "no_match", results: [] })
    }
  });
});

test("stale index with context and a match: at least partial, index_stale warning present", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    const body = await response.json();
    assert.equal(body.state, "partial");
    assert.equal(body.knowledgeState, "index_stale");
    assert.ok(body.warnings.includes("index_stale"));
  }, {
    handlerOptions: {
      adapterFactory: () => structuredAdapter().adapter,
      retrieveKnowledgeFn: async () => ({ knowledgeState: "index_stale", results: [ragResult()] })
    }
  });
});

test("old but content-current index stays available and carries only an age warning", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    const body = await response.json();
    assert.equal(body.state, "ok");
    assert.equal(body.knowledgeState, "available");
    assert.ok(body.warnings.includes("index_age_warning"));
    assert.ok(!body.warnings.includes("index_stale"));
  }, {
    handlerOptions: {
      adapterFactory: () => structuredAdapter().adapter,
      retrieveKnowledgeFn: async () => ({
        knowledgeState: "available",
        results: [ragResult()],
        indexVerification: {
          state: "content_current",
          ageWarning: true,
          modelDigestVerified: true
        }
      })
    }
  });
});

test("incompatible index remains inside the compatible response contract and is explicit", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    const body = await response.json();
    assert.equal(body.state, "partial");
    assert.equal(body.knowledgeState, "search_failed");
    assert.ok(body.warnings.includes("search_failed"));
    assert.ok(body.warnings.includes("index_incompatible"));
    assert.deepEqual(Object.keys(body).sort(), [
      "answer", "generatedAt", "knowledgeState", "schemaVersion", "sources",
      "state", "systemContextState", "warnings"
    ].sort());
  }, {
    handlerOptions: {
      adapterFactory: () => structuredAdapter({ citedSources: [] }).adapter,
      retrieveKnowledgeFn: async () => ({
        knowledgeState: "search_failed",
        results: [],
        indexVerification: {
          state: "index_incompatible",
          ageWarning: false,
          modelDigestVerified: false
        }
      })
    }
  });
});

test("index missing but context present: context-only partial answer allowed", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    const body = await response.json();
    assert.equal(body.state, "partial");
    assert.ok(body.warnings.includes("index_missing"));
    assert.deepEqual(body.sources, []);
  }, {
    handlerOptions: {
      adapterFactory: () => structuredAdapter({ citedSources: [] }).adapter,
      retrieveKnowledgeFn: async () => ({ knowledgeState: "index_missing", results: [] })
    }
  });
});

test("embedding model unavailable but context present: context-only partial answer allowed", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    const body = await response.json();
    assert.equal(body.state, "partial");
    assert.ok(body.warnings.includes("embedding_model_unavailable"));
  }, {
    handlerOptions: {
      adapterFactory: () => structuredAdapter({ citedSources: [] }).adapter,
      retrieveKnowledgeFn: async () => ({ knowledgeState: "embedding_model_unavailable", results: [] })
    }
  });
});

test("RAG search failed but context present: context-only partial answer allowed", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    const body = await response.json();
    assert.equal(body.state, "partial");
    assert.ok(body.warnings.includes("search_failed"));
  }, {
    handlerOptions: {
      adapterFactory: () => structuredAdapter({ citedSources: [] }).adapter,
      retrieveKnowledgeFn: async () => ({ knowledgeState: "search_failed", results: [] })
    }
  });
});

test("answer model missing: unavailable, answer_model_unavailable warning", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    const body = await response.json();
    assert.equal(body.state, "unavailable");
    assert.ok(body.warnings.includes("answer_model_unavailable"));
  }, { handlerOptions: { env: ccKnowledgeEnv({ AI_ROUTER_OLLAMA_MODEL: undefined }) } });
});

test("Ollama provider unreachable: unavailable, answer_provider_unavailable warning", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    const body = await response.json();
    assert.equal(body.state, "unavailable");
    assert.ok(body.warnings.includes("answer_provider_unavailable"));
  }, { handlerOptions: { adapterFactory: () => ({ async generateText() { throw new Error("network down"); } }) } });
});

test("provider timeout maps to unavailable with answer_provider_unavailable", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    const body = await response.json();
    assert.equal(body.state, "unavailable");
    assert.ok(body.warnings.includes("answer_provider_unavailable"));
  }, {
    handlerOptions: {
      env: ccKnowledgeEnv({ AI_ROUTER_OLLAMA_TIMEOUT_MS: "10" }),
      adapterFactory: () => ({ generateText: () => new Promise(() => {}) })
    }
  });
});

test("an invalid structured model output fails closed as model_response_invalid", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    const body = await response.json();
    assert.equal(body.state, "unavailable");
    assert.ok(body.warnings.includes("model_response_invalid"));
  }, { handlerOptions: { adapterFactory: () => textAdapter("not json at all") } });
});

test("a syntactically valid but out-of-range cited source id fails closed as model_source_validation_failed", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    const body = await response.json();
    assert.equal(body.state, "unavailable");
    assert.ok(body.warnings.includes("model_source_validation_failed"));
  }, { handlerOptions: { adapterFactory: () => structuredAdapter({ citedSources: ["K3"] }).adapter } });
});

test("rate limit on the second concurrent-window request returns 429 with warning rate_limited", async () => {
  await withServer(async (baseUrl) => {
    const first = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    assert.notEqual(first.status, 429);
    const second = await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
    assert.equal(second.status, 429);
    const body = await second.json();
    assert.ok(body.warnings.includes("rate_limited"));
  }, { handlerOptions: { adapterFactory: () => structuredAdapter().adapter } });
});

test("no user question or snippet text appears in logged metadata", async () => {
  const entries = [];
  await withServer(async (baseUrl) => {
    await post(baseUrl, validKnowledgeBody({ context: knowledgeContext() }));
  }, {
    handlerOptions: {
      adapterFactory: () => structuredAdapter().adapter,
      eventLogger: { log: async (entry) => { entries.push(entry); } }
    }
  });
  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes("Darf der AI-Router"));
  assert.ok(!serialized.includes("Der AI-Router empfiehlt und vermittelt"));
  assert.ok(!serialized.includes("10_Apps/90_Entscheidungen/DEC-001.md"));
});
