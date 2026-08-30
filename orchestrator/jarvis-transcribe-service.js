// Local-only speech-to-text for the /jarvis page. Calls an EXISTING
// whisper-server process (whisper.cpp's server binary, --inference-path
// /inference) over plain HTTP on 127.0.0.1. Deliberately does not spawn,
// stop or otherwise manage that process - Felix starts it himself and
// points AI_ROUTER_WHISPER_SERVER_URL at it. Verified against a real local
// instance during the 2026-08-13 architecture review (ggml-small.bin,
// ~2.2s to transcribe a 5.35s German clip, 100% accurate once the vocab
// prompt below was applied).
//
// No cloud STT anywhere in this file: WHISPER_SERVER_URL_ENV_VAR has no
// default, so a caller cannot fall back to any remote endpoint by omission,
// only to a clean WHISPER_NOT_CONFIGURED.
import {
  JARVIS_TRANSCRIBE_LANGUAGE,
  JARVIS_TRANSCRIBE_MAX_TEXT_CHARS,
  JARVIS_TRANSCRIBE_TIMEOUT_MS,
  JARVIS_TRANSCRIBE_VOCAB_PROMPT,
  WHISPER_SERVER_URL_ENV_VAR
} from "./jarvis-transcribe-config.js";
import { JarvisTranscribeError } from "./jarvis-transcribe-error.js";

function inferenceUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/inference`;
}

function truncate(text) {
  return text.length > JARVIS_TRANSCRIBE_MAX_TEXT_CHARS
    ? text.slice(0, JARVIS_TRANSCRIBE_MAX_TEXT_CHARS)
    : text;
}

// 2026-08-30 voice smoke test, real failure: whisper-server's JSON response
// can contain an internal segment-break newline (e.g. "...Google Sheet\n
// schreiben?") that survives untouched through `.trim()` (which only strips
// leading/trailing whitespace) and reaches the shared knowledge-contract
// validator's single-line rule (hasControlCharacters in
// cc-context-fields.js), which correctly rejects ANY \r/\n anywhere in the
// string - by design, not a bug, and deliberately left unchanged. The fix
// belongs here, at the STT output, not in that shared validator: collapse
// any run of \r/\n into a single space, then collapse any other whitespace
// run the same way, before the existing trim/truncate. Purely mechanical -
// no rewording, no spelling correction, no semantic change.
function normalizeTranscript(text) {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
}

export function createJarvisTranscribeService({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = JARVIS_TRANSCRIBE_TIMEOUT_MS
} = {}) {
  async function transcribe({ audio, contentType }) {
    const baseUrl = typeof env[WHISPER_SERVER_URL_ENV_VAR] === "string" ? env[WHISPER_SERVER_URL_ENV_VAR].trim() : "";
    if (!baseUrl) throw new JarvisTranscribeError("WHISPER_NOT_CONFIGURED", "No local whisper-server is configured.");
    if (typeof fetchImpl !== "function") throw new JarvisTranscribeError("WHISPER_UNAVAILABLE", "No HTTP client is available.");

    const form = new FormData();
    form.append("file", new Blob([audio], { type: contentType || "application/octet-stream" }), "jarvis-question.wav");
    form.append("language", JARVIS_TRANSCRIBE_LANGUAGE);
    form.append("response_format", "json");
    form.append("temperature", "0.0");
    form.append("prompt", JARVIS_TRANSCRIBE_VOCAB_PROMPT);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(inferenceUrl(baseUrl), { method: "POST", body: form, signal: controller.signal });
    } catch {
      throw new JarvisTranscribeError("WHISPER_UNAVAILABLE", "The local whisper-server is not reachable.", { retryable: true });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new JarvisTranscribeError("WHISPER_UNAVAILABLE", "The local whisper-server rejected the request.", { retryable: true });
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new JarvisTranscribeError("WHISPER_INVALID_RESPONSE", "The local whisper-server returned an unreadable response.");
    }
    if (typeof body?.text !== "string") {
      throw new JarvisTranscribeError("WHISPER_INVALID_RESPONSE", "The local whisper-server response has no transcript text.");
    }

    return { text: truncate(normalizeTranscript(body.text).trim()) };
  }

  return { transcribe };
}

export const transcribeInternals = Object.freeze({ inferenceUrl, truncate, normalizeTranscript });
