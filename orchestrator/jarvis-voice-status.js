// GET /api/jarvis/voice-status - deliberately separate from checkJarvisReadiness()
// (jarvis-readiness.js), not a replacement for it. That function must stay
// network-ping-free (cheap, safe to poll - see its own header comment and
// test/jarvis-readiness.test.js's "no Whisper network reachability" test).
// This module is the one place that actually probes whisper-server over
// HTTP, with a short bounded timeout, so a caller that wants the honest
// "aktiv" vs "konfiguriert" distinction can ask for it explicitly, on its
// own schedule, without slowing down or complicating the main readiness
// check that /api/jarvis/ready and npm run jarvis:start both rely on.
import fs from "node:fs/promises";
import { WHISPER_SERVER_URL_ENV_VAR } from "./jarvis-transcribe-config.js";
import { PIPER_BINARY_PATH_ENV_VAR, PIPER_VOICE_MODEL_PATH_ENV_VAR } from "./jarvis-speak-config.js";

// Whisper has three distinct states (unlike Piper's two) because whisper-
// server is a long-running process Felix starts separately from AI-Router
// (see the Felix Whisper Server autostart task) - "configured" (URL set,
// nothing answered yet or not currently running) is a real, common, benign
// state, not an error.
export const WHISPER_VOICE_STATES = Object.freeze(["active", "configured", "unavailable"]);
// Piper has no server to probe (spawned per request, see
// jarvis-speak-service.js) - "ready" here means what checkVoice() in
// jarvis-readiness.js already means: binary and voice model both exist on
// disk. No third state, because there is no reachable-vs-not distinction
// to make for a process that is never left running.
export const PIPER_VOICE_STATES = Object.freeze(["ready", "unavailable"]);

// Short on purpose: this must never make /api/jarvis/voice-status feel like
// it hung. whisper-server, when actually running, answers "/" fast (a
// static file server, not the model itself) - 800ms is generous headroom
// over a healthy local response while still failing fast when the process
// is simply not there (most common case: connection refused, near-instant).
const WHISPER_PROBE_TIMEOUT_MS = 800;

async function fileExists(statFn, filePath) {
  if (!filePath) return false;
  try {
    await statFn(filePath);
    return true;
  } catch {
    return false;
  }
}

// No --inference-path route is probed here (that only accepts POST with a
// real audio payload, see jarvis-transcribe-service.js) - a plain GET "/"
// against whisper-server's own static file server is enough to prove the
// process is up and listening, verified against a real local instance.
async function checkWhisperState(env, { fetchImplFn, timeoutMs }) {
  const whisperUrl = typeof env[WHISPER_SERVER_URL_ENV_VAR] === "string" ? env[WHISPER_SERVER_URL_ENV_VAR].trim() : "";
  if (!whisperUrl) return "unavailable";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplFn(`${whisperUrl.replace(/\/+$/, "")}/`, { signal: controller.signal });
    return response.ok ? "active" : "configured";
  } catch {
    // Covers both "connection refused" (process not running) and "timed
    // out" (process wedged) - both mean "configured, but not usable right
    // now", the same distinction WHISPER_UNAVAILABLE already draws
    // elsewhere for an actual transcription attempt.
    return "configured";
  } finally {
    clearTimeout(timer);
  }
}

async function checkPiperState(env, { statFn }) {
  const binaryPath = typeof env[PIPER_BINARY_PATH_ENV_VAR] === "string" ? env[PIPER_BINARY_PATH_ENV_VAR].trim() : "";
  const modelPath = typeof env[PIPER_VOICE_MODEL_PATH_ENV_VAR] === "string" ? env[PIPER_VOICE_MODEL_PATH_ENV_VAR].trim() : "";
  if (!binaryPath || !modelPath) return "unavailable";

  const [binaryExists, modelExists] = await Promise.all([
    fileExists(statFn, binaryPath),
    fileExists(statFn, modelPath)
  ]);
  return binaryExists && modelExists ? "ready" : "unavailable";
}

// Every dependency injectable, same DI shape as checkJarvisReadiness() -
// tests never touch a real network path or filesystem unless they choose
// to. fetchImplFn/statFn deliberately end in Fn like every sibling
// override here, not fetchImpl/stat, so a caller can never confuse "the
// function itself" with "the network/filesystem primitive it wraps".
export async function checkJarvisVoiceStatus({
  env = process.env,
  fetchImplFn = globalThis.fetch,
  timeoutMs = WHISPER_PROBE_TIMEOUT_MS,
  statFn = fs.stat
} = {}) {
  const [whisper, piper] = await Promise.all([
    checkWhisperState(env, { fetchImplFn, timeoutMs }),
    checkPiperState(env, { statFn })
  ]);
  return Object.freeze({ whisper, piper });
}
