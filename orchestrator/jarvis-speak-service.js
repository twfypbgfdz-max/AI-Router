// Local-only text-to-speech for the /jarvis page's "Vorlesen" button. Spawns
// piper.exe (the standalone MIT binary, rhasspy/piper 2023.11.14-2 - see
// README for why this was chosen over the maintained but slower/heavier
// Python package) ONCE PER REQUEST and reads the WAV it writes to stdout
// (-f -). Deliberately no daemon, no port, no persistent process: verified
// during the 2026-08-13 review that neither the standalone binary nor the
// Python package opens a single TCP/UDP socket at any point - there is
// nothing to bind, so the "127.0.0.1 not 0.0.0.0" question that applies to
// jarvis-transcribe-service.js's whisper-server simply does not arise here.
//
// buildChildEnv/terminateProcessTree are imported from codex-adapter.js
// rather than reimplemented: despite the filename they are already generic
// child-process utilities (restricted env allowlist, Windows-safe
// process-tree kill via taskkill) - the same reuse-over-duplication call
// this repo already makes for cc-context-fields.js's string validators.
import { spawn } from "node:child_process";
import { buildChildEnv, terminateProcessTree } from "./codex-adapter.js";
import {
  JARVIS_SPEAK_MAX_AUDIO_BYTES,
  JARVIS_SPEAK_TIMEOUT_MS,
  PIPER_BINARY_PATH_ENV_VAR,
  PIPER_VOICE_MODEL_PATH_ENV_VAR
} from "./jarvis-speak-config.js";
import { JarvisSpeakError } from "./jarvis-speak-error.js";

export function createJarvisSpeakService({
  env = process.env,
  spawnImpl = spawn,
  terminateImpl = terminateProcessTree,
  timeoutMs = JARVIS_SPEAK_TIMEOUT_MS,
  maxAudioBytes = JARVIS_SPEAK_MAX_AUDIO_BYTES
} = {}) {
  async function speak(text) {
    const binaryPath = typeof env[PIPER_BINARY_PATH_ENV_VAR] === "string" ? env[PIPER_BINARY_PATH_ENV_VAR].trim() : "";
    const modelPath = typeof env[PIPER_VOICE_MODEL_PATH_ENV_VAR] === "string" ? env[PIPER_VOICE_MODEL_PATH_ENV_VAR].trim() : "";
    if (!binaryPath || !modelPath) {
      throw new JarvisSpeakError("PIPER_NOT_CONFIGURED", "No local text-to-speech engine is configured.");
    }

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
        // -f - writes the WAV to stdout instead of a file; -q suppresses
        // piper's own log lines so stderr carries only real errors. Model
        // config resolves to modelPath + ".json" by piper's own default,
        // matching the layout provisioned in .ai-router-data/tts/voices/.
        child = spawnImpl(binaryPath, ["-m", modelPath, "-f", "-", "-q"], {
          shell: false,
          windowsHide: true,
          env: buildChildEnv()
        });
      } catch {
        clearTimeout(timer);
        return reject(new JarvisSpeakError("PIPER_UNAVAILABLE", "The local speech engine could not be started.", { retryable: true }));
      }

      const chunks = [];
      let size = 0;
      let oversized = false;
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        if (oversized) return;
        size += chunk.length;
        if (size > maxAudioBytes) {
          oversized = true;
          terminateImpl(child);
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 2000) stderr += chunk.toString();
      });
      child.on("error", () => {
        finish(reject, new JarvisSpeakError("PIPER_UNAVAILABLE", "The local speech engine could not be started.", { retryable: true }));
      });
      child.on("close", (code) => {
        if (oversized) {
          return finish(reject, new JarvisSpeakError("PIPER_OUTPUT_TOO_LARGE", "The synthesized audio was too large."));
        }
        if (code !== 0) {
          return finish(reject, new JarvisSpeakError("PIPER_FAILED", "The local speech engine failed.", { retryable: true }));
        }
        const audio = Buffer.concat(chunks);
        if (!audio.length) {
          return finish(reject, new JarvisSpeakError("PIPER_INVALID_OUTPUT", "The local speech engine produced no audio."));
        }
        finish(resolve, { audio });
      });

      // EPIPE guard: if the child exits (e.g. bad model path) before stdin
      // is fully written, Node would otherwise raise an unhandled error on
      // the stream itself in addition to the process "error"/"close"
      // handlers above.
      child.stdin.on("error", () => {});
      child.stdin.end(text, "utf8");
    });
  }

  return { speak };
}
