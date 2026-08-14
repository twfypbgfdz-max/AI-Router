import test from "node:test";
import assert from "node:assert/strict";
import { checkOllamaModelAvailable, getOllamaModelIdentity } from "../orchestrator/ollama-availability.js";
import { providerJsonResponse } from "./text-response-helpers.js";

const BASE_URL = "http://127.0.0.1:11434";
const MODEL = "qwen2.5:7b-instruct";

function tagsPayload(models) {
  return { models };
}

test("model present in /api/tags is reported available", async () => {
  const available = await checkOllamaModelAvailable({
    baseUrl: BASE_URL,
    model: MODEL,
    fetchImpl: async () => providerJsonResponse(tagsPayload([{ name: MODEL, model: MODEL }]), { headers: { "content-type": "application/json" } })
  });
  assert.equal(available, true);
});

test("model identity exposes a stable digest when Ollama provides one", async () => {
  const digest = "a".repeat(64);
  const identity = await getOllamaModelIdentity({
    baseUrl: BASE_URL,
    model: MODEL,
    fetchImpl: async () => providerJsonResponse(tagsPayload([{ name: MODEL, digest }]), { headers: { "content-type": "application/json" } })
  });
  assert.deepEqual(identity, { model: MODEL, digest: `sha256:${digest}` });
});

test("model identity remains usable but marks an unavailable digest as null", async () => {
  const identity = await getOllamaModelIdentity({
    baseUrl: BASE_URL,
    model: MODEL,
    fetchImpl: async () => providerJsonResponse(tagsPayload([{ name: MODEL }]), { headers: { "content-type": "application/json" } })
  });
  assert.deepEqual(identity, { model: MODEL, digest: null });
});

test("model absent from /api/tags is reported unavailable, not an error", async () => {
  const available = await checkOllamaModelAvailable({
    baseUrl: BASE_URL,
    model: MODEL,
    fetchImpl: async () => providerJsonResponse(tagsPayload([{ name: "other-model", model: "other-model" }]), { headers: { "content-type": "application/json" } })
  });
  assert.equal(available, false);
});

test("an empty models list is reported unavailable", async () => {
  const available = await checkOllamaModelAvailable({
    baseUrl: BASE_URL,
    model: MODEL,
    fetchImpl: async () => providerJsonResponse(tagsPayload([]), { headers: { "content-type": "application/json" } })
  });
  assert.equal(available, false);
});

test("Ollama unreachable (connection refused) fails closed as PROVIDER_UNAVAILABLE", async () => {
  await assert.rejects(
    checkOllamaModelAvailable({
      baseUrl: BASE_URL,
      model: MODEL,
      fetchImpl: async () => {
        const error = new TypeError("fetch failed");
        error.cause = { code: "ECONNREFUSED" };
        throw error;
      }
    }),
    { code: "PROVIDER_UNAVAILABLE", safeDetails: { reason: "provider_network_error" } }
  );
});

test("a redirect from /api/tags is rejected, not followed", async () => {
  let requested = null;
  await assert.rejects(
    checkOllamaModelAvailable({
      baseUrl: BASE_URL,
      model: MODEL,
      fetchImpl: async (url, options) => {
        requested = options;
        const error = new TypeError("fetch failed");
        error.cause = new Error("unexpected redirect");
        throw error;
      }
    }),
    { code: "PROVIDER_UNAVAILABLE", safeDetails: { reason: "redirect_blocked" } }
  );
  assert.equal(requested.redirect, "error");
});

test("a slow /api/tags request times out", async () => {
  await assert.rejects(
    checkOllamaModelAvailable({
      baseUrl: BASE_URL,
      model: MODEL,
      timeoutMs: 5,
      fetchImpl: (url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
    }),
    { code: "PROVIDER_TIMEOUT" }
  );
});

test("a non-2xx /api/tags response fails closed", async () => {
  await assert.rejects(
    checkOllamaModelAvailable({
      baseUrl: BASE_URL,
      model: MODEL,
      fetchImpl: async () => providerJsonResponse({ error: "boom" }, { status: 500 })
    }),
    { code: "PROVIDER_UNAVAILABLE", safeDetails: { reason: "provider_http_error" } }
  );
});

test("a wrong content-type on /api/tags is rejected", async () => {
  await assert.rejects(
    checkOllamaModelAvailable({
      baseUrl: BASE_URL,
      model: MODEL,
      fetchImpl: async () => ({
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/plain" : null) },
        text: async () => "not json"
      })
    }),
    { code: "PROVIDER_RESPONSE_INVALID", safeDetails: { reason: "provider_response_invalid" } }
  );
});

test("invalid JSON from /api/tags is rejected", async () => {
  await assert.rejects(
    checkOllamaModelAvailable({
      baseUrl: BASE_URL,
      model: MODEL,
      fetchImpl: async () => ({
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
        text: async () => "{"
      })
    }),
    { code: "PROVIDER_RESPONSE_INVALID", safeDetails: { reason: "provider_json_invalid" } }
  );
});

test("an unexpected /api/tags shape (extra field, non-array models) is rejected", async () => {
  await assert.rejects(
    checkOllamaModelAvailable({
      baseUrl: BASE_URL,
      model: MODEL,
      fetchImpl: async () => providerJsonResponse({ models: [], extra: true }, { headers: { "content-type": "application/json" } })
    }),
    { code: "PROVIDER_RESPONSE_INVALID", safeDetails: { reason: "provider_response_invalid" } }
  );
  await assert.rejects(
    checkOllamaModelAvailable({
      baseUrl: BASE_URL,
      model: MODEL,
      fetchImpl: async () => providerJsonResponse({ models: "not-an-array" }, { headers: { "content-type": "application/json" } })
    }),
    { code: "PROVIDER_RESPONSE_INVALID", safeDetails: { reason: "provider_response_invalid" } }
  );
});

test("a /api/tags response declared or actually over the size limit is rejected", async () => {
  await assert.rejects(
    checkOllamaModelAvailable({
      baseUrl: BASE_URL,
      model: MODEL,
      maxBodyBytes: 10,
      fetchImpl: async () => ({
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === "content-length" ? "9999" : name.toLowerCase() === "content-type" ? "application/json" : null) },
        body: { cancel: async () => {} },
        text: async () => ""
      })
    }),
    { code: "PROVIDER_RESPONSE_INVALID", safeDetails: { reason: "provider_body_too_large" } }
  );
});

test("missing configuration is rejected", async () => {
  await assert.rejects(checkOllamaModelAvailable({ model: MODEL }), { code: "PROVIDER_NOT_CONFIGURED" });
  await assert.rejects(checkOllamaModelAvailable({ baseUrl: BASE_URL }), { code: "PROVIDER_NOT_CONFIGURED" });
});
