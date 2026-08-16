import { readJsonBody } from "./http-utils.js";
import {
  JARVIS_SPEAK_MAX_REQUEST_BYTES,
  JARVIS_SPEAK_MAX_TEXT_CHARS,
  JARVIS_SPEAK_SCHEMA_VERSION
} from "./jarvis-speak-config.js";
import { JarvisSpeakError } from "./jarvis-speak-error.js";
import { createJarvisSpeakService } from "./jarvis-speak-service.js";
import { normalizeForSpeech } from "./jarvis-speak-normalize.js";

const HTTP_STATUS = Object.freeze({
  METHOD_NOT_ALLOWED: 405,
  INVALID_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  PIPER_NOT_CONFIGURED: 503,
  PIPER_UNAVAILABLE: 503,
  PIPER_TIMEOUT: 504,
  PIPER_OUTPUT_TOO_LARGE: 502,
  PIPER_FAILED: 502,
  PIPER_INVALID_OUTPUT: 502,
  INTERNAL_ERROR: 500
});

const SAFE_MESSAGES = Object.freeze({
  METHOD_NOT_ALLOWED: "Method is not allowed.",
  INVALID_REQUEST: "The text could not be read.",
  PAYLOAD_TOO_LARGE: "The request body is too large.",
  PIPER_NOT_CONFIGURED: "No local text-to-speech engine is configured.",
  PIPER_UNAVAILABLE: "The local text-to-speech engine is not available.",
  PIPER_TIMEOUT: "The local text-to-speech engine took too long.",
  PIPER_OUTPUT_TOO_LARGE: "The synthesized audio was too large.",
  PIPER_FAILED: "The local text-to-speech engine failed.",
  PIPER_INVALID_OUTPUT: "The local text-to-speech engine produced no audio.",
  INTERNAL_ERROR: "The speech request could not be completed."
});

function sendJsonError(response, code) {
  const status = HTTP_STATUS[code] || 500;
  const payload = { schemaVersion: JARVIS_SPEAK_SCHEMA_VERSION, error: { code, message: SAFE_MESSAGES[code] || SAFE_MESSAGES.INTERNAL_ERROR } };
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

// Binary success response deliberately carries no JSON envelope, matching
// the pattern of felix-command-center's azure-speech route: the body IS the
// WAV, nothing wraps it.
function sendAudio(response, buffer) {
  response.writeHead(200, {
    "content-type": "audio/wav",
    "content-length": String(buffer.length),
    "cache-control": "no-store"
  });
  response.end(buffer);
}

export function createJarvisSpeakHandler({ service = createJarvisSpeakService() } = {}) {
  return async function handleJarvisSpeak(request, response) {
    try {
      if (request.method !== "POST") {
        return sendJsonError(response, "METHOD_NOT_ALLOWED");
      }

      let body;
      try {
        body = await readJsonBody(request, JARVIS_SPEAK_MAX_REQUEST_BYTES);
      } catch (error) {
        return sendJsonError(response, error?.code === "PAYLOAD_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST");
      }

      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text || text.length > JARVIS_SPEAK_MAX_TEXT_CHARS) {
        return sendJsonError(response, "INVALID_REQUEST");
      }

      // DEC-008: deterministic, model-free cleanup of display-only
      // artifacts (source markers, relative vault paths) before the text
      // reaches Piper. Applied after the length/shape validation above (so
      // the character cap still governs the actual request body, not a
      // post-normalization shorter string) and before service.speak - no
      // request/response contract field changes.
      const result = await service.speak(normalizeForSpeech(text));
      return sendAudio(response, result.audio);
    } catch (error) {
      const code = error instanceof JarvisSpeakError ? error.code : "INTERNAL_ERROR";
      return sendJsonError(response, code);
    }
  };
}

export const handleJarvisSpeakRequest = createJarvisSpeakHandler();
