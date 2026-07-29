import test from "node:test";
import assert from "node:assert/strict";
import { assertEmbeddingModelAvailable, embedText } from "../orchestrator/knowledge/embedding-client.js";
import { RagError } from "../orchestrator/knowledge/rag-error.js";
import { providerJsonResponse } from "./text-response-helpers.js";

const BASE_URL = "http://127.0.0.1:11434";
const MODEL = "bge-m3";

test("assertEmbeddingModelAvailable resolves when the model is present", async () => {
  await assertEmbeddingModelAvailable({
    baseUrl: BASE_URL,
    model: MODEL,
    fetchImpl: async () => providerJsonResponse({ models: [{ name: MODEL, model: MODEL }] }, { headers: { "content-type": "application/json" } })
  });
});

test("assertEmbeddingModelAvailable throws EMBEDDING_MODEL_NOT_AVAILABLE when absent", async () => {
  await assert.rejects(
    assertEmbeddingModelAvailable({
      baseUrl: BASE_URL,
      model: MODEL,
      fetchImpl: async () => providerJsonResponse({ models: [] }, { headers: { "content-type": "application/json" } })
    }),
    (error) => error instanceof RagError && error.code === "EMBEDDING_MODEL_NOT_AVAILABLE"
  );
});

test("assertEmbeddingModelAvailable throws EMBEDDING_PROVIDER_UNAVAILABLE when unreachable", async () => {
  await assert.rejects(
    assertEmbeddingModelAvailable({
      baseUrl: BASE_URL,
      model: MODEL,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      }
    }),
    (error) => error.code === "EMBEDDING_PROVIDER_UNAVAILABLE"
  );
});

test("embedText returns a numeric vector from a valid response", async () => {
  const vector = await embedText("hello world", {
    baseUrl: BASE_URL,
    model: MODEL,
    timeoutMs: 1000,
    fetchImpl: async (url) => {
      assert.equal(url, `${BASE_URL}/api/embed`);
      return providerJsonResponse({ embeddings: [[0.1, 0.2, 0.3]] }, { headers: { "content-type": "application/json" } });
    }
  });
  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
});

test("embedText rejects an invalid response shape", async () => {
  await assert.rejects(
    embedText("hello", {
      baseUrl: BASE_URL,
      model: MODEL,
      timeoutMs: 1000,
      fetchImpl: async () => providerJsonResponse({ nothing: true }, { headers: { "content-type": "application/json" } })
    }),
    (error) => error.code === "EMBEDDING_RESPONSE_INVALID"
  );
});

test("embedText times out and throws EMBEDDING_TIMEOUT", async () => {
  await assert.rejects(
    embedText("hello", {
      baseUrl: BASE_URL,
      model: MODEL,
      timeoutMs: 5,
      fetchImpl: (url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })
    }),
    (error) => error.code === "EMBEDDING_TIMEOUT"
  );
});

test("embedText rejects a non-ok HTTP status", async () => {
  await assert.rejects(
    embedText("hello", {
      baseUrl: BASE_URL,
      model: MODEL,
      timeoutMs: 1000,
      fetchImpl: async () => providerJsonResponse({}, { status: 500, headers: { "content-type": "application/json" } })
    }),
    (error) => error.code === "EMBEDDING_PROVIDER_UNAVAILABLE"
  );
});

test("embedText never calls a non-loopback URL (caller-supplied baseUrl only)", async () => {
  let calledUrl = null;
  await embedText("hello", {
    baseUrl: BASE_URL,
    model: MODEL,
    timeoutMs: 1000,
    fetchImpl: async (url) => {
      calledUrl = url;
      return providerJsonResponse({ embeddings: [[0.1]] }, { headers: { "content-type": "application/json" } });
    }
  });
  assert.ok(calledUrl.startsWith("http://127.0.0.1:11434"));
});
