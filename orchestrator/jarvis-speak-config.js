// Constants for POST /api/jarvis/speak - local-only text-to-speech for a
// deliberate "Vorlesen" button on an already-displayed /jarvis answer. See
// jarvis-speak-service.js for why this spawns a process per request instead
// of running a daemon.
import path from "node:path";
import { DATA_DIR } from "./config.js";

export const JARVIS_SPEAK_SCHEMA_VERSION = "1.0";

// No defaults on either path, same reasoning as WHISPER_SERVER_URL_ENV_VAR
// in jarvis-transcribe-config.js: an unset value must surface as a clean
// PIPER_NOT_CONFIGURED rather than a guessed path silently doing nothing or
// running the wrong binary/voice. Unlike the STT step this does NOT lean on
// an existing external app's install - Felix Core owns this file layout.
// Provisioned during the 2026-08-13 review at
// .ai-router-data/tts/piper/piper.exe and
// .ai-router-data/tts/voices/de_DE-thorsten-high.onnx (with its sibling
// .onnx.json alongside, Piper's default config-path convention) - both
// paths are gitignored (.ai-router-data/) and must be set via .env.
export const PIPER_BINARY_PATH_ENV_VAR = "AI_ROUTER_PIPER_BINARY_PATH";
export const PIPER_VOICE_MODEL_PATH_ENV_VAR = "AI_ROUTER_PIPER_VOICE_MODEL_PATH";

// Defensive cap on the text handed to piper.exe via stdin. This route reads
// back text the knowledge route already produced and the page already
// displayed (KNOWLEDGE_ANSWER_MAX_BYTES = 4096 bytes there) - independent,
// separate constant, same "separate contracts, separate counters"
// convention as every other pair of related limits in this repo. Larger
// than a realistic answer on purpose, just bounded.
export const JARVIS_SPEAK_MAX_TEXT_CHARS = 4000;
export const JARVIS_SPEAK_MAX_REQUEST_BYTES = 16 * 1024;

// Measured 2026-08-13 with the standalone MIT binary and de_DE-thorsten-high
// (the confirmed choice, see README): ~4.2s cold start (process spawn incl.
// ~0.56s model load) for a 12.8s test clip, real-time factor ~0.30 (audio
// generated ~3.3x faster than its own playback length). 60s gives a
// multi-paragraph answer generous headroom over that measured rate while
// still failing fast if piper.exe hangs.
export const JARVIS_SPEAK_TIMEOUT_MS = 60_000;

// 22.05kHz/16-bit mono WAV runs ~44.1 KB/s of audio; 12 MiB bounds a spoken
// answer to roughly 4.5 minutes, far beyond anything this route is meant
// to read aloud, while still capping a pathological response.
export const JARVIS_SPEAK_MAX_AUDIO_BYTES = 12 * 1024 * 1024;

// BUGFIX 2026-08-13: piper.exe's own "-f -" (stdout) WAV output is corrupt
// on this Windows binary - confirmed via two independent OS-level capture
// paths (Node's child_process pipe AND a native cmd.exe `>` redirect, which
// share no code with each other) both producing the identical corruption
// signature (WAV header's declared data-chunk size short of the actual
// byte count; PCM sample statistics showing ~3x amplitude and ~2.5x
// zero-crossing rate versus a clean reference, with erratic sample-to-
// sample jumps consistent with byte-level misalignment). "-f <file>"
// (real file, not stdout) was verified clean in the same comparison,
// including with -q. The corruption therefore lives inside piper.exe's own
// stdout write path on Windows (most likely: that code path never switches
// the stdout handle out of the OS's default CRT text mode before writing
// binary data, unlike its file-write path) - nothing our own spawn/stream
// handling could fix, since the bytes are already wrong before they leave
// the process. jarvis-speak-service.js therefore has piper write to a
// short-lived, per-request temp file instead of stdout, reads that file
// into memory once, and deletes it in the same request before the HTTP
// response is sent - "no audio persisted to disk" is preserved as "no
// audio outlives its own request", not as "no file object is ever created".
export const JARVIS_SPEAK_TMP_DIR = path.join(DATA_DIR, "tts", "tmp");
