import { sendJson } from "./http-utils.js";
import { JARVIS_TRANSCRIBE_MAX_AUDIO_BYTES, JARVIS_TRANSCRIBE_SCHEMA_VERSION } from "./jarvis-transcribe-config.js";
import { JarvisTranscribeError } from "./jarvis-transcribe-error.js";
import { createJarvisTranscribeService } from "./jarvis-transcribe-service.js";

const HTTP_STATUS = Object.freeze({
  METHOD_NOT_ALLOWED: 405,
  INVALID_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  WHISPER_NOT_CONFIGURED: 503,
  WHISPER_UNAVAILABLE: 503,
  WHISPER_INVALID_RESPONSE: 502,
  INTERNAL_ERROR: 500
});

const SAFE_MESSAGES = Object.freeze({
  METHOD_NOT_ALLOWED: "Method is not allowed.",
  INVALID_REQUEST: "The audio request could not be read.",
  PAYLOAD_TOO_LARGE: "The recording is too large.",
  WHISPER_NOT_CONFIGURED: "No local speech-to-text server is configured.",
  WHISPER_UNAVAILABLE: "The local speech-to-text server is not reachable.",
  WHISPER_INVALID_RESPONSE: "The local speech-to-text server returned an unusable response.",
  INTERNAL_ERROR: "The transcription request could not be completed."
});

function failure(code) {
  return { schemaVersion: JARVIS_TRANSCRIBE_SCHEMA_VERSION, error: { code, message: SAFE_MESSAGES[code] || SAFE_MESSAGES.INTERNAL_ERROR } };
}

function httpStatusFor(code) {
  return HTTP_STATUS[code] || 500;
}

// Raw binary body reader, bounded by maxBytes, mirroring the drain-then-
// reject shape of readJsonBody in http-utils.js - but returning a Buffer
// rather than parsing JSON, since the body here is audio.
function readRawBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.destroy?.();
        finish(reject, new JarvisTranscribeError("PAYLOAD_TOO_LARGE", "Request body is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish(resolve, Buffer.concat(chunks)));
    request.on("error", () => finish(reject, new JarvisTranscribeError("INVALID_REQUEST", "Request body could not be read.")));
    request.on("aborted", () => finish(reject, new JarvisTranscribeError("INVALID_REQUEST", "Request body was aborted.")));
  });
}

export function createJarvisTranscribeHandler({ service = createJarvisTranscribeService() } = {}) {
  return async function handleJarvisTranscribe(request, response) {
    try {
      if (request.method !== "POST") {
        return sendJson(response, 405, failure("METHOD_NOT_ALLOWED"));
      }

      const contentType = String(request.headers["content-type"] || "").toLowerCase();
      if (!contentType.startsWith("audio/")) {
        return sendJson(response, 400, failure("INVALID_REQUEST"));
      }

      let audio;
      try {
        audio = await readRawBody(request, JARVIS_TRANSCRIBE_MAX_AUDIO_BYTES);
      } catch (error) {
        const code = error instanceof JarvisTranscribeError ? error.code : "INVALID_REQUEST";
        return sendJson(response, httpStatusFor(code), failure(code));
      }
      if (!audio.length) {
        return sendJson(response, 400, failure("INVALID_REQUEST"));
      }

      const result = await service.transcribe({ audio, contentType });
      return sendJson(response, 200, { schemaVersion: JARVIS_TRANSCRIBE_SCHEMA_VERSION, text: result.text });
    } catch (error) {
      const code = error instanceof JarvisTranscribeError ? error.code : "INTERNAL_ERROR";
      return sendJson(response, httpStatusFor(code), failure(code));
    }
  };
}

export const handleJarvisTranscribeRequest = createJarvisTranscribeHandler();
