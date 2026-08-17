// Manual-only entry point: `npm run jarvis:start`. The single recommended
// way to start Jarvis. Reuses checkJarvisReadiness() (P2-A) as the sole
// source of truth for the start/no-start gate - this script adds a
// human-readable report on top of it, nothing else. No duplicated readiness
// logic, no new reason vocabulary: every gate-relevant string below only
// re-describes a code checkJarvisReadiness() already produces. The report
// additionally calls checkJarvisVoiceStatus() (orchestrator/
// jarvis-voice-status.js) once, purely for honest display - Whisper/Piper
// state never affects whether the router starts, only what the printed
// Voice: lines say.
//
// Read-only, exactly like the readiness check itself: no model pull, no
// `npm run rag:reindex`, no starting/stopping Ollama or whisper-server, no
// spawning Piper. The only side effect on a usable Core is starting the
// already-existing router bootstrap (startRouterServer() in
// orchestrator/server.js) - the same one `npm start` uses, unchanged.
//
// `npm start` remains separately available, ungated, for Command-Center-/
// router-only use that does not depend on Ollama or the RAG index at all
// (e.g. /api/router/project-status, /api/router/git-changes,
// /api/v1/cc/status) - this script exists specifically for Jarvis, and
// therefore specifically gates on it. Deliberately no --force escape
// hatch: `npm start` already is that escape hatch, by design, not by flag.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkJarvisReadiness } from "../orchestrator/jarvis-readiness.js";
import { checkJarvisVoiceStatus } from "../orchestrator/jarvis-voice-status.js";
import { startRouterServer } from "../orchestrator/server.js";

// Presentation only. An unrecognised code (should never happen - this list
// is exactly the closed vocabulary jarvis-readiness.js's own reasonByState/
// mapping produces) falls back to printing the raw code rather than hiding
// it, so a future new reason code fails visibly instead of silently.
const REASON_TEXT = Object.freeze({
  answer_provider_unavailable: "Ollama ist nicht erreichbar.",
  answer_model_unavailable: "Das Chat-Modell ist nicht verfügbar (nicht installiert oder falsch konfiguriert).",
  embedding_model_unavailable: "Das Embedding-Modell ist nicht verfügbar (nicht installiert, nicht konfiguriert oder Ollama nicht erreichbar).",
  index_missing: "Kein RAG-Index vorhanden - \"npm run rag:reindex\" manuell ausführen.",
  index_stale: "RAG-Index ist inhaltlich veraltet - der letzte bekannte Stand wird weiter verwendet, \"npm run rag:reindex\" ist empfohlen.",
  index_incompatible: "RAG-Index ist mit der aktuellen Konfiguration nicht kompatibel - \"npm run rag:reindex\" ist nötig.",
  index_error: "RAG-Index ist beschädigt oder unlesbar - \"npm run rag:reindex\" ist nötig.",
  WHISPER_NOT_CONFIGURED: "Spracheingabe (Whisper) ist nicht konfiguriert.",
  PIPER_NOT_CONFIGURED: "Sprachausgabe (Piper) ist nicht konfiguriert.",
  PIPER_UNAVAILABLE: "Piper ist konfiguriert, aber Binary oder Stimme fehlt auf der Platte."
});

// Same closed vocabulary checkJarvisVoiceStatus() produces (see
// orchestrator/jarvis-voice-status.js) - presentation only, no new states
// invented here.
const WHISPER_STATE_TEXT = Object.freeze({ active: "aktiv", configured: "konfiguriert", unavailable: "nicht verfügbar" });
const PIPER_STATE_TEXT = Object.freeze({ ready: "bereit", unavailable: "nicht verfügbar" });

export function describeReason(reason) {
  return REASON_TEXT[reason] || reason;
}

// Replaces the old, misleading flat "Voice: bereit." (true only if both
// engines' ENV vars happened to be set, never checked against whether
// Whisper's server process was actually running) with the two engines'
// real, independently-checked states. Piper has no "reachable" concept
// (spawned per request, see jarvis-speak-config.js) - Whisper does, because
// whisper-server is a long-running process started separately from
// AI-Router (see the Felix Whisper Server autostart task).
function formatVoiceLines(voiceStatus) {
  const piperText = PIPER_STATE_TEXT[voiceStatus.piper] || voiceStatus.piper;
  const whisperText = WHISPER_STATE_TEXT[voiceStatus.whisper] || voiceStatus.whisper;
  return ["Voice:", `  Piper TTS: ${piperText}`, `  Whisper STT: ${whisperText}`].join("\n");
}

// voiceStatus is optional so this function stays testable in isolation
// (existing tests exercise it without a voice status); runJarvisStart()
// below always supplies a real one.
export function formatReadinessReport(readiness, voiceStatus) {
  const reasonLines = readiness.reasons.map((reason) => `  - ${describeReason(reason)}`);
  const coreLines = readiness.state === "ready"
    ? ["Jarvis core ready."]
    : readiness.state === "partial"
      ? ["Jarvis partial:", ...reasonLines]
      : ["Jarvis unavailable:", ...reasonLines];
  if (!voiceStatus) return coreLines.join("\n");
  return [...coreLines, "", formatVoiceLines(voiceStatus)].join("\n");
}

// The one decision point: whether to start the router at all. Every
// dependency is injectable so this can be tested without a real Ollama, a
// real index or a real listening socket; the CLI entry point below supplies
// the real ones.
export async function runJarvisStart({
  checkReadinessFn = checkJarvisReadiness,
  checkVoiceStatusFn = checkJarvisVoiceStatus,
  startServerFn = startRouterServer,
  log = console.log,
  errorLog = console.error
} = {}) {
  const readiness = await checkReadinessFn();
  const voiceStatus = await checkVoiceStatusFn();
  const report = formatReadinessReport(readiness, voiceStatus);

  if (readiness.state === "unavailable") {
    errorLog(report);
    process.exitCode = 1;
    return { readiness, started: false };
  }

  log(report);
  startServerFn();
  return { readiness, started: true };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await runJarvisStart();
