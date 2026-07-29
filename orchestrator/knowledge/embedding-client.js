import { RagError } from "./rag-error.js";
import { RAG_EMBEDDING_MAX_BODY_BYTES } from "./rag-config.js";
import { checkOllamaModelAvailable } from "../ollama-availability.js";

// Read-only availability probe, reusing the exact same /api/tags check the
// chat provider uses. Never triggers a pull, never accepts a client-chosen
// model or URL - both come from the already-validated embedding config.
export async function assertEmbeddingModelAvailable({ baseUrl, model, fetchImpl = globalThis.fetch } = {}) {
  let available;
  try {
    available = await checkOllamaModelAvailable({ baseUrl, model, fetchImpl });
  } catch {
    throw new RagError("EMBEDDING_PROVIDER_UNAVAILABLE", "Ollama is not reachable for embeddings.", { safeDetails: { reason: "provider_unreachable" } });
  }
  if (!available) {
    throw new RagError("EMBEDDING_MODEL_NOT_AVAILABLE", "The configured embedding model is not installed in Ollama.", {
      safeDetails: { reason: "model_not_pulled", hint: "Requires a manual 'ollama pull' - never pulled automatically." }
    });
  }
}

async function readBoundedJson(response, maxBodyBytes) {
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new RagError("EMBEDDING_RESPONSE_INVALID", "Ollama embed response had an unexpected content type.");
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > maxBodyBytes) {
    throw new RagError("EMBEDDING_RESPONSE_INVALID", "Ollama embed response exceeded its transport limit.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new RagError("EMBEDDING_RESPONSE_INVALID", "Ollama embed response was not valid JSON.");
  }
}

// Single-text embedding call against the loopback-only Ollama /api/embed
// endpoint. baseUrl is always the already-loopback-validated value from
// loadOllamaEmbeddingProviderConfig - this function does not itself parse or
// accept a raw URL.
export async function embedText(text, { baseUrl, model, timeoutMs, fetchImpl = globalThis.fetch } = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw new RagError("EMBEDDING_RESPONSE_INVALID", "Cannot embed empty text.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    try {
      response = await fetchImpl(`${baseUrl}/api/embed`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: text }),
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RagError("EMBEDDING_TIMEOUT", "Ollama embed request timed out.");
      }
      throw new RagError("EMBEDDING_PROVIDER_UNAVAILABLE", "Ollama embed request failed.", { safeDetails: { reason: "network_error" } });
    }
    if (!response?.ok) {
      response?.body?.cancel?.().catch?.(() => {});
      throw new RagError("EMBEDDING_PROVIDER_UNAVAILABLE", "Ollama embed request returned an error status.", { safeDetails: { status: response?.status } });
    }
    const payload = await readBoundedJson(response, RAG_EMBEDDING_MAX_BODY_BYTES);
    const vector = Array.isArray(payload?.embeddings?.[0]) ? payload.embeddings[0] : Array.isArray(payload?.embedding) ? payload.embedding : null;
    if (!vector || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new RagError("EMBEDDING_RESPONSE_INVALID", "Ollama embed response did not contain a valid vector.");
    }
    return Object.freeze(vector);
  } finally {
    clearTimeout(timer);
  }
}
