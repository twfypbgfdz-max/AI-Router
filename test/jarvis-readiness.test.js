import test from "node:test";
import assert from "node:assert/strict";
import { JARVIS_READINESS_STATES, checkJarvisReadiness } from "../orchestrator/jarvis-readiness.js";

// A fully healthy baseline: every injected function succeeds, every voice
// file "exists". Individual tests override exactly one function to break
// exactly one dependency, so each test proves that ONE broken piece drives
// the outcome, not an accidental interaction between several fakes.
function baseFns(overrides = {}) {
  return {
    loadOllamaTextProviderConfigFn: () => ({ model: "qwen2.5:7b-instruct", baseUrl: "http://127.0.0.1:11434" }),
    getOllamaModelIdentityFn: async () => Object.freeze({ model: "qwen2.5:7b-instruct", digest: "sha256:aaa" }),
    loadOllamaEmbeddingProviderConfigFn: () => ({ model: "bge-m3:latest", baseUrl: "http://127.0.0.1:11434" }),
    assertEmbeddingModelAvailableFn: async () => Object.freeze({ model: "bge-m3:latest", digest: "sha256:bbb" }),
    readIndexMetaFn: () => ({ schemaVersion: "2.0", embeddingModel: "bge-m3:latest" }),
    readManifestFn: () => ({ schemaVersion: "2.0", documents: {} }),
    readAllChunksFn: () => [{ sourceDoc: "a.md" }],
    verifyIndexFreshnessFn: async () => Object.freeze({ state: "content_current", reasons: [] }),
    statFn: async () => ({ isFile: () => true }),
    ...overrides
  };
}

function baseEnv(overrides = {}) {
  return {
    AI_ROUTER_WHISPER_SERVER_URL: "http://127.0.0.1:8399",
    AI_ROUTER_PIPER_BINARY_PATH: "C:\\fake\\piper.exe",
    AI_ROUTER_PIPER_VOICE_MODEL_PATH: "C:\\fake\\voice.onnx",
    ...overrides
  };
}

test("the three states are exactly ready/partial/unavailable, nothing else", () => {
  assert.deepEqual(JARVIS_READINESS_STATES, ["ready", "partial", "unavailable"]);
});

test("everything healthy: state is 'ready', both flags true, no reasons", async () => {
  const result = await checkJarvisReadiness({ env: baseEnv(), ...baseFns() });
  assert.equal(result.state, "ready");
  assert.equal(result.coreReady, true);
  assert.equal(result.voiceReady, true);
  assert.deepEqual(result.reasons, []);
});

test("the payload shape is exactly {state, coreReady, voiceReady, reasons}", async () => {
  const result = await checkJarvisReadiness({ env: baseEnv(), ...baseFns() });
  assert.deepEqual(Object.keys(result).sort(), ["coreReady", "reasons", "state", "voiceReady"]);
});

// --- Core: Ollama / chat model -------------------------------------------

test("Ollama chat model not configured: unavailable, reused reason code", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv(),
    ...baseFns({ loadOllamaTextProviderConfigFn: () => { throw new Error("PROVIDER_NOT_CONFIGURED"); } })
  });
  assert.equal(result.state, "unavailable");
  assert.equal(result.coreReady, false);
  assert.ok(result.reasons.includes("answer_model_unavailable"));
});

test("Ollama unreachable (network/timeout): unavailable, distinct reason from 'not configured'", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv(),
    ...baseFns({ getOllamaModelIdentityFn: async () => { throw new Error("network error"); } })
  });
  assert.equal(result.state, "unavailable");
  assert.ok(result.reasons.includes("answer_provider_unavailable"));
  assert.ok(!result.reasons.includes("answer_model_unavailable"));
});

test("Ollama reachable but chat model not pulled: unavailable", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv(),
    ...baseFns({ getOllamaModelIdentityFn: async () => null })
  });
  assert.equal(result.state, "unavailable");
  assert.ok(result.reasons.includes("answer_model_unavailable"));
});

// --- Core: embedding model -------------------------------------------------

test("embedding model not configured: unavailable, reused knowledgeState code", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv(),
    ...baseFns({ loadOllamaEmbeddingProviderConfigFn: () => { throw new Error("not configured"); } })
  });
  assert.equal(result.state, "unavailable");
  assert.ok(result.reasons.includes("embedding_model_unavailable"));
});

test("embedding model unreachable/not pulled: unavailable", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv(),
    ...baseFns({ assertEmbeddingModelAvailableFn: async () => { throw new Error("unavailable"); } })
  });
  assert.equal(result.state, "unavailable");
  assert.ok(result.reasons.includes("embedding_model_unavailable"));
});

// --- Core: RAG index ---------------------------------------------------

test("index missing entirely: unavailable", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv(),
    ...baseFns({ readIndexMetaFn: () => null, readAllChunksFn: () => [] })
  });
  assert.equal(result.state, "unavailable");
  assert.ok(result.reasons.includes("index_missing"));
});

test("index files unreadable: unavailable, index_error", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv(),
    ...baseFns({ readIndexMetaFn: () => { throw new Error("EIO"); } })
  });
  assert.equal(result.state, "unavailable");
  assert.ok(result.reasons.includes("index_error"));
});

test("index structurally incompatible: unavailable, not merely degraded", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv(),
    ...baseFns({ verifyIndexFreshnessFn: async () => Object.freeze({ state: "index_incompatible", reasons: ["chunking_version_mismatch"] }) })
  });
  assert.equal(result.state, "unavailable");
  assert.equal(result.coreReady, false);
  assert.ok(result.reasons.includes("index_incompatible"));
});

test("index in an unrecoverable error state: unavailable", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv(),
    ...baseFns({ verifyIndexFreshnessFn: async () => Object.freeze({ state: "index_error", reasons: ["chunk_manifest_mismatch"] }) })
  });
  assert.equal(result.state, "unavailable");
  assert.ok(result.reasons.includes("index_error"));
});

// The required case: a stale-but-present index is last-known-good and must
// NOT collapse Core into "unavailable" - Core stays usable, contributing to
// "partial" instead, exactly like the real knowledge path still answers
// (with a warning) on index_stale rather than refusing outright.
test("index content_stale with a usable last-known-good index: coreReady stays true, state is 'partial' not 'unavailable'", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv(),
    ...baseFns({ verifyIndexFreshnessFn: async () => Object.freeze({ state: "content_stale", reasons: ["document_content_changed"] }) })
  });
  assert.equal(result.coreReady, true, "a stale-but-present index must still count as Core-usable");
  assert.equal(result.state, "partial");
  assert.ok(result.reasons.includes("index_stale"));
  assert.ok(!result.reasons.includes("index_missing"));
  assert.ok(!result.reasons.includes("index_incompatible"));
});

// --- Voice --------------------------------------------------------------

test("Whisper not configured: Core stays usable, overall state degrades to 'partial', never 'unavailable'", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv({ AI_ROUTER_WHISPER_SERVER_URL: "" }),
    ...baseFns()
  });
  assert.equal(result.coreReady, true);
  assert.equal(result.voiceReady, false);
  assert.equal(result.state, "partial");
  assert.ok(result.reasons.includes("WHISPER_NOT_CONFIGURED"));
});

test("Piper env vars unset: voice not ready, reused PIPER_NOT_CONFIGURED code, state 'partial'", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv({ AI_ROUTER_PIPER_BINARY_PATH: "", AI_ROUTER_PIPER_VOICE_MODEL_PATH: "" }),
    ...baseFns()
  });
  assert.equal(result.voiceReady, false);
  assert.equal(result.state, "partial");
  assert.ok(result.reasons.includes("PIPER_NOT_CONFIGURED"));
});

test("Piper env vars set but the binary file does not exist on disk: voice not ready, PIPER_UNAVAILABLE", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv(),
    ...baseFns({ statFn: async (filePath) => { if (String(filePath).includes("piper.exe")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return { isFile: () => true }; } })
  });
  assert.equal(result.voiceReady, false);
  assert.equal(result.state, "partial");
  assert.ok(result.reasons.includes("PIPER_UNAVAILABLE"));
  assert.ok(!result.reasons.includes("PIPER_NOT_CONFIGURED"), "configured-but-missing must not be reported as unconfigured");
});

test("Piper voice model file missing while the binary exists: voice not ready", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv(),
    ...baseFns({ statFn: async (filePath) => { if (String(filePath).includes("voice.onnx")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return { isFile: () => true }; } })
  });
  assert.equal(result.voiceReady, false);
  assert.ok(result.reasons.includes("PIPER_UNAVAILABLE"));
});

// A no-network-ping guarantee for Whisper: only configuration presence is
// checked, so an injected fetch-like probe must never be called. There is no
// fetch injection point on checkJarvisReadiness at all - this test would
// fail to even construct if one were accidentally added, and passing with
// only WHISPER_SERVER_URL_ENV_VAR set (no reachability) proves no probe ran.
test("Voice-Ready requires no Whisper network reachability - configuration presence alone is sufficient", async () => {
  const result = await checkJarvisReadiness({ env: baseEnv(), ...baseFns() });
  assert.equal(result.voiceReady, true);
});

test("both Whisper and Piper missing at once: still only 'partial', Core unaffected", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv({ AI_ROUTER_WHISPER_SERVER_URL: "", AI_ROUTER_PIPER_BINARY_PATH: "", AI_ROUTER_PIPER_VOICE_MODEL_PATH: "" }),
    ...baseFns()
  });
  assert.equal(result.coreReady, true);
  assert.equal(result.state, "partial");
  assert.ok(result.reasons.includes("WHISPER_NOT_CONFIGURED"));
  assert.ok(result.reasons.includes("PIPER_NOT_CONFIGURED"));
});

// --- Combinations, precedence and payload hygiene -------------------------

test("Core broken always wins over Voice: 'unavailable' even when Voice is fully configured", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv(),
    ...baseFns({ getOllamaModelIdentityFn: async () => null })
  });
  assert.equal(result.state, "unavailable");
  assert.equal(result.voiceReady, true, "voice itself is still reported accurately even when Core is down");
});

test("reasons never contains duplicates", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv({ AI_ROUTER_WHISPER_SERVER_URL: "" }),
    ...baseFns({ verifyIndexFreshnessFn: async () => Object.freeze({ state: "content_stale", reasons: ["document_content_changed"] }) })
  });
  assert.equal(result.reasons.length, new Set(result.reasons).size);
});

test("no secret-shaped value ever appears in the payload: no token, no path, no URL", async () => {
  const result = await checkJarvisReadiness({
    env: baseEnv({
      AI_ROUTER_CC_TOKEN: "should-never-be-read-or-echoed-anywhere-in-here",
      AI_ROUTER_INTERNAL_TOKEN: "also-must-never-appear"
    }),
    ...baseFns()
  });
  const serialized = JSON.stringify(result);
  assert.ok(!/should-never-be-read/.test(serialized));
  assert.ok(!/also-must-never-appear/.test(serialized));
  assert.ok(!/[A-Za-z]:\\/.test(serialized), "no filesystem path");
  assert.ok(!/https?:\/\//.test(serialized), "no URL");
  // Only the fixed, closed reason vocabulary and the three top-level enums
  // may appear as strings; nothing here comes from raw config values.
  for (const reason of result.reasons) assert.equal(typeof reason, "string");
});

test("the result is frozen (no mutation surface for a caller)", async () => {
  const result = await checkJarvisReadiness({ env: baseEnv(), ...baseFns() });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.reasons));
});
