import test from "node:test";
import assert from "node:assert/strict";
import { loadOllamaEmbeddingProviderConfig } from "../orchestrator/knowledge/rag-config.js";
import { RagError } from "../orchestrator/knowledge/rag-error.js";

test("loads a valid embedding config, separate from the chat model", () => {
  const config = loadOllamaEmbeddingProviderConfig({
    AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "bge-m3",
    AI_ROUTER_OLLAMA_MODEL: "qwen2.5:7b-instruct",
    AI_ROUTER_OLLAMA_BASE_URL: "http://localhost:11434"
  });
  assert.equal(config.model, "bge-m3");
  assert.notEqual(config.model, "qwen2.5:7b-instruct");
});

test("throws EMBEDDING_MODEL_NOT_AVAILABLE when the embedding model is unset", () => {
  assert.throws(
    () => loadOllamaEmbeddingProviderConfig({}),
    (error) => error instanceof RagError && error.code === "EMBEDDING_MODEL_NOT_AVAILABLE"
  );
});

test("rejects a non-loopback base URL", () => {
  assert.throws(
    () => loadOllamaEmbeddingProviderConfig({ AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "bge-m3", AI_ROUTER_OLLAMA_BASE_URL: "http://example.com" }),
    (error) => error.code === "EMBEDDING_PROVIDER_UNAVAILABLE"
  );
});
