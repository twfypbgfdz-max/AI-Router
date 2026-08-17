import test from "node:test";
import assert from "node:assert/strict";
import { WHISPER_VOICE_STATES, PIPER_VOICE_STATES, checkJarvisVoiceStatus } from "../orchestrator/jarvis-voice-status.js";

function baseEnv(overrides = {}) {
  return {
    AI_ROUTER_WHISPER_SERVER_URL: "http://127.0.0.1:8178",
    AI_ROUTER_PIPER_BINARY_PATH: "C:\\fake\\piper.exe",
    AI_ROUTER_PIPER_VOICE_MODEL_PATH: "C:\\fake\\voice.onnx",
    ...overrides
  };
}

const alwaysExists = async () => ({ isFile: () => true });

test("the states are exactly the closed vocabularies documented", () => {
  assert.deepEqual(WHISPER_VOICE_STATES, ["active", "configured", "unavailable"]);
  assert.deepEqual(PIPER_VOICE_STATES, ["ready", "unavailable"]);
});

// --- Whisper --------------------------------------------------------------

test("Whisper not configured (no URL): 'unavailable', no fetch attempted", async () => {
  let fetchCalled = false;
  const result = await checkJarvisVoiceStatus({
    env: baseEnv({ AI_ROUTER_WHISPER_SERVER_URL: "" }),
    fetchImplFn: async () => { fetchCalled = true; return { ok: true }; },
    statFn: alwaysExists
  });
  assert.equal(result.whisper, "unavailable");
  assert.equal(fetchCalled, false);
});

test("Whisper configured and the server answers 200: 'active'", async () => {
  const result = await checkJarvisVoiceStatus({
    env: baseEnv(),
    fetchImplFn: async (url) => { assert.equal(url, "http://127.0.0.1:8178/"); return { ok: true }; },
    statFn: alwaysExists
  });
  assert.equal(result.whisper, "active");
});

test("Whisper configured but the server answers a non-2xx status: 'configured'", async () => {
  const result = await checkJarvisVoiceStatus({
    env: baseEnv(),
    fetchImplFn: async () => ({ ok: false, status: 500 }),
    statFn: alwaysExists
  });
  assert.equal(result.whisper, "configured");
});

test("Whisper configured but unreachable (connection refused): 'configured', not 'unavailable'", async () => {
  const result = await checkJarvisVoiceStatus({
    env: baseEnv(),
    fetchImplFn: async () => { throw new Error("ECONNREFUSED"); },
    statFn: alwaysExists
  });
  assert.equal(result.whisper, "configured");
});

test("Whisper configured but the probe times out: 'configured'", async () => {
  const result = await checkJarvisVoiceStatus({
    env: baseEnv(),
    timeoutMs: 5,
    fetchImplFn: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
    statFn: alwaysExists
  });
  assert.equal(result.whisper, "configured");
});

test("a trailing slash in the configured URL is not doubled", async () => {
  const result = await checkJarvisVoiceStatus({
    env: baseEnv({ AI_ROUTER_WHISPER_SERVER_URL: "http://127.0.0.1:8178/" }),
    fetchImplFn: async (url) => { assert.equal(url, "http://127.0.0.1:8178/"); return { ok: true }; },
    statFn: alwaysExists
  });
  assert.equal(result.whisper, "active");
});

// --- Piper ------------------------------------------------------------------

test("Piper env vars unset: 'unavailable'", async () => {
  const result = await checkJarvisVoiceStatus({
    env: baseEnv({ AI_ROUTER_PIPER_BINARY_PATH: "", AI_ROUTER_PIPER_VOICE_MODEL_PATH: "" }),
    fetchImplFn: async () => ({ ok: true }),
    statFn: alwaysExists
  });
  assert.equal(result.piper, "unavailable");
});

test("Piper configured and both files exist: 'ready'", async () => {
  const result = await checkJarvisVoiceStatus({
    env: baseEnv(),
    fetchImplFn: async () => ({ ok: true }),
    statFn: alwaysExists
  });
  assert.equal(result.piper, "ready");
});

test("Piper configured but the binary is missing on disk: 'unavailable'", async () => {
  const result = await checkJarvisVoiceStatus({
    env: baseEnv(),
    fetchImplFn: async () => ({ ok: true }),
    statFn: async (filePath) => { if (String(filePath).includes("piper.exe")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return { isFile: () => true }; }
  });
  assert.equal(result.piper, "unavailable");
});

// --- Payload hygiene / independence -----------------------------------------

test("Whisper and Piper are checked independently - one being down does not affect the other", async () => {
  const result = await checkJarvisVoiceStatus({
    env: baseEnv({ AI_ROUTER_WHISPER_SERVER_URL: "" }),
    fetchImplFn: async () => ({ ok: true }),
    statFn: alwaysExists
  });
  assert.equal(result.whisper, "unavailable");
  assert.equal(result.piper, "ready");
});

test("the result is frozen (no mutation surface for a caller)", async () => {
  const result = await checkJarvisVoiceStatus({
    env: baseEnv(),
    fetchImplFn: async () => ({ ok: true }),
    statFn: alwaysExists
  });
  assert.ok(Object.isFrozen(result));
});

test("no secret-shaped value ever appears in the payload: no path, no URL", async () => {
  const result = await checkJarvisVoiceStatus({
    env: baseEnv(),
    fetchImplFn: async () => ({ ok: true }),
    statFn: alwaysExists
  });
  const serialized = JSON.stringify(result);
  assert.ok(!/[A-Za-z]:\\/.test(serialized), "no filesystem path");
  assert.ok(!/https?:\/\//.test(serialized), "no URL");
});
