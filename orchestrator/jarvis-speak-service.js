// Local-only text-to-speech for the /jarvis page's "Vorlesen" button. Spawns
// piper.exe (the standalone MIT binary, rhasspy/piper 2023.11.14-2 - see
// README for why this was chosen over the maintained but slower/heavier
// Python package) ONCE PER REQUEST. Deliberately no daemon, no port, no
// persistent process: verified during the 2026-08-13 review that neither
// the standalone binary nor the Python package opens a single TCP/UDP
// socket at any point - there is nothing to bind, so the "127.0.0.1 not
// 0.0.0.0" question that applies to jarvis-transcribe-service.js's
// whisper-server simply does not arise here.
//
// Piper writes its WAV to a short-lived, per-request temp file
// (JARVIS_SPEAK_TMP_DIR) rather than stdout - see the BUGFIX comment on
// JARVIS_SPEAK_TMP_DIR in jarvis-speak-config.js for why: piper.exe's own
// "-f -" stdout output is corrupt on this Windows binary, confirmed via two
// independent capture paths, while "-f <file>" is clean. The temp file is
// read into memory once and deleted before this function returns, in a
// finally block that runs on every exit path including errors.
//
// buildChildEnv/terminateProcessTree are imported from codex-adapter.js
// rather than reimplemented: despite the filename they are already generic
// child-process utilities (restricted env allowlist, Windows-safe
// process-tree kill via taskkill) - the same reuse-over-duplication call
// this repo already makes for cc-context-fields.js's string validators.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { buildChildEnv, terminateProcessTree } from "./codex-adapter.js";
import {
  JARVIS_SPEAK_MAX_AUDIO_BYTES,
  JARVIS_SPEAK_TIMEOUT_MS,
  JARVIS_SPEAK_TMP_DIR,
  PIPER_BINARY_PATH_ENV_VAR,
  PIPER_VOICE_MODEL_PATH_ENV_VAR
} from "./jarvis-speak-config.js";
import { JarvisSpeakError } from "./jarvis-speak-error.js";

function runPiper({ binaryPath, modelPath, outputFile, text, spawnImpl, terminateImpl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      Promise.resolve(terminateImpl(child)).finally(() => {
        finish(reject, new JarvisSpeakError("PIPER_TIMEOUT", "The local speech engine took too long.", { retryable: true }));
      });
    }, timeoutMs);

    try {
      // -f <file> writes a real, seekable WAV file (the clean, verified
      // path - see the module doc comment); -q suppresses piper's own log
      // lines so stderr carries only real errors. Model config resolves to
      // modelPath + ".json" by piper's own default, matching the layout
      // provisioned in .ai-router-data/tts/voices/.
      child = spawnImpl(binaryPath, ["-m", modelPath, "-f", outputFile, "-q"], {
        shell: false,
        windowsHide: true,
        env: buildChildEnv()
      });
    } catch {
      clearTimeout(timer);
      return reject(new JarvisSpeakError("PIPER_UNAVAILABLE", "The local speech engine could not be started.", { retryable: true }));
    }

    let stderr = "";
    child.stdout?.on("data", () => {}); // drained, unused with -f <file>
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    child.on("error", () => {
      finish(reject, new JarvisSpeakError("PIPER_UNAVAILABLE", "The local speech engine could not be started.", { retryable: true }));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        return finish(reject, new JarvisSpeakError("PIPER_FAILED", "The local speech engine failed.", { retryable: true }));
      }
      finish(resolve, undefined);
    });

    // EPIPE guard: if the child exits (e.g. bad model path) before stdin is
    // fully written, Node would otherwise raise an unhandled error on the
    // stream itself in addition to the process "error"/"close" handlers.
    child.stdin.on("error", () => {});
    child.stdin.end(text, "utf8");
  });
}

export function createJarvisSpeakService({
  env = process.env,
  spawnImpl = spawn,
  terminateImpl = terminateProcessTree,
  timeoutMs = JARVIS_SPEAK_TIMEOUT_MS,
  maxAudioBytes = JARVIS_SPEAK_MAX_AUDIO_BYTES,
  tmpDir = JARVIS_SPEAK_TMP_DIR
} = {}) {
  async function speak(text) {
    const binaryPath = typeof env[PIPER_BINARY_PATH_ENV_VAR] === "string" ? env[PIPER_BINARY_PATH_ENV_VAR].trim() : "";
    const modelPath = typeof env[PIPER_VOICE_MODEL_PATH_ENV_VAR] === "string" ? env[PIPER_VOICE_MODEL_PATH_ENV_VAR].trim() : "";
    if (!binaryPath || !modelPath) {
      throw new JarvisSpeakError("PIPER_NOT_CONFIGURED", "No local text-to-speech engine is configured.");
    }

    await fs.mkdir(tmpDir, { recursive: true });
    const outputFile = path.join(tmpDir, `speak-${crypto.randomUUID()}.wav`);

    try {
      await runPiper({ binaryPath, modelPath, outputFile, text, spawnImpl, terminateImpl, timeoutMs });

      let stat;
      try {
        stat = await fs.stat(outputFile);
      } catch {
        throw new JarvisSpeakError("PIPER_INVALID_OUTPUT", "The local speech engine produced no audio.");
      }
      if (!stat.size) {
        throw new JarvisSpeakError("PIPER_INVALID_OUTPUT", "The local speech engine produced no audio.");
      }
      if (stat.size > maxAudioBytes) {
        throw new JarvisSpeakError("PIPER_OUTPUT_TOO_LARGE", "The synthesized audio was too large.");
      }

      const audio = await fs.readFile(outputFile);
      return { audio };
    } finally {
      await fs.rm(outputFile, { force: true }).catch(() => {});
    }
  }

  return { speak };
}
