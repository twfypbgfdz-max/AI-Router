// Constants for POST /api/jarvis/transcribe - local-only speech-to-text for
// the /jarvis page's question field. See jarvis-transcribe-service.js for
// why this deliberately does NOT start or manage a whisper-server process.
export const JARVIS_TRANSCRIBE_SCHEMA_VERSION = "1.0";

// Name only, mirrors the pattern of every other AI_ROUTER_* setting: read
// once per request from process.env, never logged, never written to a file.
// Unlike AI_ROUTER_OLLAMA_BASE_URL this has NO default - an unset value
// means "no whisper-server has been pointed at", which must surface as a
// clean WHISPER_NOT_CONFIGURED rather than a guessed port silently
// connecting to the wrong process. Felix starts whisper-server.exe himself
// (this route never spawns it) and sets this to wherever it is actually
// listening, e.g. http://127.0.0.1:8399.
export const WHISPER_SERVER_URL_ENV_VAR = "AI_ROUTER_WHISPER_SERVER_URL";

// Fixed, not configurable per request: the page has no language picker and
// Felix Core's spoken interaction is German-only, same as the rest of the
// Jarvis surface.
export const JARVIS_TRANSCRIBE_LANGUAGE = "de";

// The vocabulary prompt verified during the 2026-08-13 architecture review to
// fix whisper.cpp's observed German-audio failure modes on project
// vocabulary ("Core" -> "Korn", "Vault" -> "Volt") with the small model - the
// original terms were corrected by this prompt in that test, with no
// measurable latency cost. Passed to whisper-server as the --prompt /
// "prompt" form field, which biases decoding without appearing in the
// output text itself.
//
// Extended 2026-08-30 (voice smoke test, real failure): a spoken question
// containing "Google Sheet" / "sheet-update-gateway" / "KI-Projektsteuerung"
// was mistranscribed and the RAG path correctly answered "nicht beantwortet"
// on the resulting garbage text - the same typed question answered
// correctly, isolating the failure to the STT step, not RAG/routing/answer
// logic (all left untouched). The original list simply predates this set of
// terms. Same mechanism as before, no parameter or model change.
export const JARVIS_TRANSCRIBE_VOCAB_PROMPT =
  "Felix Core, FELIX_SYSTEM, Vault, Jarvis, AI-Router, Command Center, " +
  "Plateau-Brecher, Obsidian, Google Sheet, KI-Projektsteuerung, " +
  "sheet-update-gateway, Single Source of Truth, RAG, Ollama, Whisper, " +
  "Approval, Run.";

// Bounds a mono 16-bit PCM WAV clip at typical browser sample rates
// (44.1/48 kHz) to roughly 60-70s - matched to the page's own client-side
// auto-stop at 60s recorded seconds. A generous but real ceiling: this is a
// spoken question for a 500-character text field, not a dictation tool.
export const JARVIS_TRANSCRIBE_MAX_AUDIO_BYTES = 8 * 1024 * 1024;

// Local CPU transcription measured at roughly 0.4x real time for a 5s clip
// with the small model (2.2s to transcribe 5.35s of audio). 45s gives a 60s
// clip (the page's own recording ceiling) comfortable headroom even on a
// loaded machine, while still failing fast if whisper-server has hung.
export const JARVIS_TRANSCRIBE_TIMEOUT_MS = 45_000;

// Defensive cap on the transcript text handed back to the page, independent
// of and larger than the question field's own 500-character limit - this
// route does not enforce that contract, it only prevents a pathological
// whisper-server response from growing unbounded before the page decides
// what to do with it.
export const JARVIS_TRANSCRIBE_MAX_TEXT_CHARS = 2000;
