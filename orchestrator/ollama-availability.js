import { TextResponseError } from "./text-response-error.js";

export const OLLAMA_TAGS_TIMEOUT_MS = 1_500;
export const OLLAMA_TAGS_MAX_BODY_BYTES = 64 * 1024;
const MAX_MODEL_ENTRIES_CHECKED = 500;

async function readBoundedTagsJson(response, maxBodyBytes) {
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Ollama tags response had an unexpected content type.", {
      safeDetails: { reason: "provider_response_invalid" }
    });
  }
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    response.body?.cancel?.().catch?.(() => {});
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Ollama tags response exceeded its transport limit.", {
      safeDetails: { reason: "provider_body_too_large" }
    });
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > maxBodyBytes) {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Ollama tags response exceeded its transport limit.", {
      safeDetails: { reason: "provider_body_too_large" }
    });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Ollama tags response was not valid JSON.", {
      safeDetails: { reason: "provider_json_invalid" }
    });
  }
}

function normalizeTagsFetchError(error, signal) {
  if (error instanceof TextResponseError) return error;
  if (signal.aborted) {
    if (signal.reason instanceof TextResponseError) return signal.reason;
    return new TextResponseError("PROVIDER_TIMEOUT", "Ollama tags request timed out.", {
      safeDetails: { reason: "provider_timeout" }
    });
  }
  if (error?.cause?.message === "unexpected redirect") {
    return new TextResponseError("PROVIDER_UNAVAILABLE", "Ollama tags redirect was rejected.", {
      retryable: false,
      safeDetails: { reason: "redirect_blocked" }
    });
  }
  return new TextResponseError("PROVIDER_UNAVAILABLE", "Ollama is not reachable.", {
    retryable: false,
    safeDetails: { reason: "provider_network_error" }
  });
}

// Read-only GET /api/tags probe: is Ollama reachable, and is the exact
// configured model present? Never mutates anything, never triggers a model
// pull, never accepts a client-chosen model or base URL - both come only
// from the server's own already-validated (loopback-only) configuration.
export async function getOllamaModelIdentity({
  baseUrl,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = OLLAMA_TAGS_TIMEOUT_MS,
  maxBodyBytes = OLLAMA_TAGS_MAX_BODY_BYTES
} = {}) {
  if (typeof baseUrl !== "string" || !baseUrl || typeof model !== "string" || !model) {
    throw new TextResponseError("PROVIDER_NOT_CONFIGURED", "The text provider is not configured.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new TextResponseError("PROVIDER_TIMEOUT", "Ollama tags request timed out.", {
      safeDetails: { reason: "provider_timeout" }
    }));
  }, timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/api/tags`, {
        method: "GET",
        redirect: "error",
        signal: controller.signal
      });
    } catch (error) {
      throw normalizeTagsFetchError(error, controller.signal);
    }
    if (!response?.ok) {
      response?.body?.cancel?.().catch?.(() => {});
      throw new TextResponseError("PROVIDER_UNAVAILABLE", "Ollama tags request failed.", {
        retryable: false,
        safeDetails: { reason: "provider_http_error" }
      });
    }
    const payload = await readBoundedTagsJson(response, maxBodyBytes);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).some((key) => key !== "models") || !Array.isArray(payload.models)) {
      throw new TextResponseError("PROVIDER_RESPONSE_INVALID", "Ollama tags response has an unexpected shape.", {
        safeDetails: { reason: "provider_response_invalid" }
      });
    }
    const matchingEntry = payload.models.slice(0, MAX_MODEL_ENTRIES_CHECKED).find((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry.name === model || entry.model === model));
    if (!matchingEntry) return null;
    const rawDigest = typeof matchingEntry.digest === "string" ? matchingEntry.digest.trim().toLowerCase() : "";
    const digest = /^(?:sha256:)?[a-f0-9]{64}$/.test(rawDigest)
      ? (rawDigest.startsWith("sha256:") ? rawDigest : `sha256:${rawDigest}`)
      : null;
    return Object.freeze({ model, digest });
  } finally {
    clearTimeout(timer);
  }
}

export async function checkOllamaModelAvailable(options = {}) {
  return (await getOllamaModelIdentity(options)) !== null;
}
