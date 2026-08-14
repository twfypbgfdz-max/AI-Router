// Read-only aggregation for GET /api/jarvis/ready. Answers exactly one
// question before a real request is made: can Jarvis actually be used right
// now, and if not, why? Every individual check below already existed and is
// already load-bearing elsewhere in this codebase (the same functions the
// real knowledge/text-response paths call) - this module adds no new
// provider client, no new check, only orchestration and a small, reused
// vocabulary of reason codes.
//
// Deliberately NOT here: no embedding of a real question, no RAG search, no
// Ollama chat completion, no whisper-server network call, no piper spawn.
// Readiness is meant to be cheap and safe to poll; the actual first real
// request still goes through the full, already-existing fail-closed path
// (knowledge-service.js, jarvis-transcribe-service.js,
// jarvis-speak-service.js) and is the final authority on whether an answer
// can really be produced. This endpoint can therefore say "ready" and a
// subsequent real request can still fail (e.g. a model pulled seconds
// earlier not yet warmed up) - that gap is accepted, not solved here.
import fs from "node:fs/promises";
import { getOllamaModelIdentity } from "./ollama-availability.js";
import { loadOllamaTextProviderConfig } from "./text-response-config.js";
import { loadOllamaEmbeddingProviderConfig } from "./knowledge/rag-config.js";
import { assertEmbeddingModelAvailable } from "./knowledge/embedding-client.js";
import { readAllChunks, readIndexMeta, readManifest } from "./knowledge/rag-index-store.js";
import { verifyIndexFreshness } from "./knowledge/rag-index-freshness.js";
import { WHISPER_SERVER_URL_ENV_VAR } from "./jarvis-transcribe-config.js";
import { PIPER_BINARY_PATH_ENV_VAR, PIPER_VOICE_MODEL_PATH_ENV_VAR } from "./jarvis-speak-config.js";

export const JARVIS_READINESS_STATES = Object.freeze(["ready", "partial", "unavailable"]);

// loadOllamaTextProviderConfig() reads AI_ROUTER_OLLAMA_MODEL/
// AI_ROUTER_OLLAMA_BASE_URL directly - the same two variables Jarvis's own
// knowledge engine always uses for its chat model, regardless of the
// AI_ROUTER_TEXT_PROVIDER switch (knowledge-service.js pins that switch to
// "ollama" internally). Checking with the same function here means this
// reports the model Jarvis would actually call, not a hypothetical one.
async function checkChatModel(env, { loadOllamaTextProviderConfigFn, getOllamaModelIdentityFn }) {
  let config;
  try {
    config = loadOllamaTextProviderConfigFn(env);
  } catch {
    return { available: false, reason: "answer_model_unavailable" };
  }
  let identity;
  try {
    identity = await getOllamaModelIdentityFn({ baseUrl: config.baseUrl, model: config.model });
  } catch {
    // Ollama itself unreachable (network/timeout) - distinct from "reachable
    // but this particular model isn't pulled" below. Same two reason codes
    // knowledge-service.js already maps PROVIDER_TIMEOUT/PROVIDER_UNAVAILABLE
    // and PROVIDER_NOT_CONFIGURED to (see mapGenerationFailureWarning).
    return { available: false, reason: "answer_provider_unavailable" };
  }
  if (!identity) return { available: false, reason: "answer_model_unavailable" };
  return { available: true, reason: null };
}

// Mirrors the first stage of knowledge-answer-rag-service.js's
// retrieveKnowledge(): same config loader, same availability assertion. The
// resulting modelIdentity is also what verifyIndexFreshness needs below to
// judge digest compatibility, so it is threaded through rather than
// re-derived.
async function checkEmbeddingModel(env, { loadOllamaEmbeddingProviderConfigFn, assertEmbeddingModelAvailableFn }) {
  let config;
  try {
    config = loadOllamaEmbeddingProviderConfigFn(env);
  } catch {
    return { available: false, reason: "embedding_model_unavailable", modelIdentity: null };
  }
  try {
    const identity = await assertEmbeddingModelAvailableFn(config);
    return { available: true, reason: null, modelIdentity: identity || Object.freeze({ model: config.model, digest: null }) };
  } catch {
    return { available: false, reason: "embedding_model_unavailable", modelIdentity: null };
  }
}

// Same three structural states retrieveKnowledge() itself distinguishes
// before it would embed a question: unreadable/missing index files, and the
// four verifyIndexFreshness() states. No question is embedded and no search
// runs here - this only asks "does a usable index exist", not "does it
// answer well".
async function checkIndex(env, now, modelIdentity, { readIndexMetaFn, readManifestFn, readAllChunksFn, verifyIndexFreshnessFn }) {
  let meta;
  let manifest;
  let chunks;
  try {
    meta = readIndexMetaFn();
    manifest = readManifestFn();
    chunks = readAllChunksFn();
  } catch {
    return { state: "index_error", reason: "index_error" };
  }
  if (!meta || chunks.length === 0) {
    return { state: "index_missing", reason: "index_missing" };
  }
  const verification = await verifyIndexFreshnessFn({ env, now, meta, manifest, chunks, modelIdentity });
  const reasonByState = Object.freeze({
    content_current: null,
    // Usable last-known-good, not a hard failure - this is exactly the case
    // that must contribute to "partial", never to "unavailable".
    content_stale: "index_stale",
    index_incompatible: "index_incompatible",
    index_error: "index_error"
  });
  // Not `??`: content_current legitimately maps to `null` ("no reason"),
  // and `??` treats that null as absent too, collapsing it back to the
  // "index_error" fallback - exactly the bug this explicit `in` check
  // avoids.
  const reason = verification.state in reasonByState ? reasonByState[verification.state] : "index_error";
  return { state: verification.state, reason };
}

async function fileExists(statFn, filePath) {
  if (!filePath) return false;
  try {
    await statFn(filePath);
    return true;
  } catch {
    return false;
  }
}

// No network probe of whisper-server on purpose (explicitly out of scope
// for this patch) - configuration presence only, the same distinction
// jarvis-transcribe-service.js itself draws between WHISPER_NOT_CONFIGURED
// (no attempt made) and WHISPER_UNAVAILABLE (attempt made, failed). Piper
// has no server to probe at all (it is spawned per request, see
// jarvis-speak-service.js), so a cheap existence check on both files is the
// closest available equivalent to "is this usable" without ever spawning a
// process from a readiness check.
async function checkVoice(env, { statFn }) {
  const reasons = [];

  const whisperUrl = typeof env[WHISPER_SERVER_URL_ENV_VAR] === "string" ? env[WHISPER_SERVER_URL_ENV_VAR].trim() : "";
  const whisperConfigured = Boolean(whisperUrl);
  if (!whisperConfigured) reasons.push("WHISPER_NOT_CONFIGURED");

  const piperBinaryPath = typeof env[PIPER_BINARY_PATH_ENV_VAR] === "string" ? env[PIPER_BINARY_PATH_ENV_VAR].trim() : "";
  const piperModelPath = typeof env[PIPER_VOICE_MODEL_PATH_ENV_VAR] === "string" ? env[PIPER_VOICE_MODEL_PATH_ENV_VAR].trim() : "";
  let piperReady = false;
  if (!piperBinaryPath || !piperModelPath) {
    reasons.push("PIPER_NOT_CONFIGURED");
  } else {
    const [binaryExists, modelExists] = await Promise.all([
      fileExists(statFn, piperBinaryPath),
      fileExists(statFn, piperModelPath)
    ]);
    piperReady = binaryExists && modelExists;
    // Configured but the file isn't actually there - the same failure mode
    // runPiper() would hit as a spawn ENOENT, mapped to the same
    // JarvisSpeakError code jarvis-speak-service.js already uses for "the
    // local speech engine could not be started".
    if (!piperReady) reasons.push("PIPER_UNAVAILABLE");
  }

  return { voiceReady: whisperConfigured && piperReady, reasons: Object.freeze(reasons) };
}

// The single aggregation point. Every dependency function has a real
// default and an injectable override, the same DI shape every other
// checked-in service module in this repo already uses (e.g.
// knowledge-answer-rag-service.js's retrieveKnowledge) - tests never touch
// a real network or filesystem path unless they choose to.
export async function checkJarvisReadiness({
  env = process.env,
  now = () => new Date(),
  loadOllamaTextProviderConfigFn = loadOllamaTextProviderConfig,
  getOllamaModelIdentityFn = getOllamaModelIdentity,
  loadOllamaEmbeddingProviderConfigFn = loadOllamaEmbeddingProviderConfig,
  assertEmbeddingModelAvailableFn = assertEmbeddingModelAvailable,
  readIndexMetaFn = readIndexMeta,
  readManifestFn = readManifest,
  readAllChunksFn = readAllChunks,
  verifyIndexFreshnessFn = verifyIndexFreshness,
  statFn = fs.stat
} = {}) {
  const fns = {
    loadOllamaTextProviderConfigFn,
    getOllamaModelIdentityFn,
    loadOllamaEmbeddingProviderConfigFn,
    assertEmbeddingModelAvailableFn,
    readIndexMetaFn,
    readManifestFn,
    readAllChunksFn,
    verifyIndexFreshnessFn,
    statFn
  };

  const chat = await checkChatModel(env, fns);
  const embedding = await checkEmbeddingModel(env, fns);
  const index = await checkIndex(env, now, embedding.modelIdentity, fns);
  const voice = await checkVoice(env, fns);

  // Not usable at all: any of the three hard Core dependencies is down, or
  // the index itself has nothing usable to offer (missing, or structurally
  // incompatible/corrupt). content_stale is deliberately absent from this
  // list - a stale-but-present index still answers, just with a
  // last-known-good warning the knowledge path already surfaces.
  const coreBroken = !chat.available
    || !embedding.available
    || index.state === "index_missing"
    || index.state === "index_incompatible"
    || index.state === "index_error";
  const coreFullyFresh = !coreBroken && index.state === "content_current";

  let state;
  if (coreBroken) state = "unavailable";
  else if (coreFullyFresh && voice.voiceReady) state = "ready";
  else state = "partial";

  const reasons = [];
  if (chat.reason) reasons.push(chat.reason);
  if (embedding.reason) reasons.push(embedding.reason);
  if (index.reason) reasons.push(index.reason);
  reasons.push(...voice.reasons);

  return Object.freeze({
    state,
    coreReady: !coreBroken,
    voiceReady: voice.voiceReady,
    reasons: Object.freeze([...new Set(reasons)])
  });
}

export const jarvisReadinessInternals = Object.freeze({ checkChatModel, checkEmbeddingModel, checkIndex, checkVoice });
