import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createJarvisSpeakService } from "../orchestrator/jarvis-speak-service.js";
import { PIPER_BINARY_PATH_ENV_VAR, PIPER_VOICE_MODEL_PATH_ENV_VAR, JARVIS_SPEAK_MAX_AUDIO_BYTES } from "../orchestrator/jarvis-speak-config.js";

const CONFIGURED_ENV = {
  [PIPER_BINARY_PATH_ENV_VAR]: "C:\\fake\\piper.exe",
  [PIPER_VOICE_MODEL_PATH_ENV_VAR]: "C:\\fake\\voice.onnx"
};

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.written = null;
  child.stdin.end = (text) => { child.stdin.written = text; };
  child.killed = false;
  return child;
}

function fakeSpawn(behavior) {
  const calls = [];
  const impl = (binaryPath, args, options) => {
    const child = fakeChild();
    calls.push({ binaryPath, args, options, child });
    queueMicrotask(() => behavior(child));
    return child;
  };
  return { impl, calls };
}

test("throws PIPER_NOT_CONFIGURED when either path is missing", async () => {
  const service = createJarvisSpeakService({ env: {}, spawnImpl: fakeSpawn(() => {}).impl });
  await assert.rejects(() => service.speak("Hallo"), (error) => error.code === "PIPER_NOT_CONFIGURED");
});

test("throws PIPER_NOT_CONFIGURED when only the binary path is set", async () => {
  const service = createJarvisSpeakService({
    env: { [PIPER_BINARY_PATH_ENV_VAR]: "C:\\fake\\piper.exe" },
    spawnImpl: fakeSpawn(() => {}).impl
  });
  await assert.rejects(() => service.speak("Hallo"), (error) => error.code === "PIPER_NOT_CONFIGURED");
});

test("spawns the configured binary with -m, -f -, -q and writes text to stdin", async () => {
  const { impl, calls } = fakeSpawn((child) => {
    child.stdout.emit("data", Buffer.from("RIFF....WAVEfmt "));
    child.emit("close", 0);
  });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl });
  await service.speak("Wo liegt Felix Core?");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].binaryPath, "C:\\fake\\piper.exe");
  assert.deepEqual(calls[0].args, ["-m", "C:\\fake\\voice.onnx", "-f", "-", "-q"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].child.stdin.written, "Wo liegt Felix Core?");
});

test("resolves with the concatenated stdout as the audio buffer", async () => {
  const { impl } = fakeSpawn((child) => {
    child.stdout.emit("data", Buffer.from("RIFF"));
    child.stdout.emit("data", Buffer.from("1234"));
    child.emit("close", 0);
  });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl });
  const result = await service.speak("Text");
  assert.ok(Buffer.isBuffer(result.audio));
  assert.equal(result.audio.toString(), "RIFF1234");
});

test("maps a spawn failure to PIPER_UNAVAILABLE, retryable", async () => {
  const impl = () => { throw new Error("ENOENT"); };
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl });
  await assert.rejects(() => service.speak("Text"), (error) => error.code === "PIPER_UNAVAILABLE" && error.retryable === true);
});

test("maps a process 'error' event to PIPER_UNAVAILABLE", async () => {
  const { impl } = fakeSpawn((child) => { child.emit("error", new Error("spawn failed")); });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl });
  await assert.rejects(() => service.speak("Text"), (error) => error.code === "PIPER_UNAVAILABLE");
});

test("maps a non-zero exit code to PIPER_FAILED, retryable", async () => {
  const { impl } = fakeSpawn((child) => { child.emit("close", 1); });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl });
  await assert.rejects(() => service.speak("Text"), (error) => error.code === "PIPER_FAILED" && error.retryable === true);
});

test("maps an empty stdout with exit code 0 to PIPER_INVALID_OUTPUT", async () => {
  const { impl } = fakeSpawn((child) => { child.emit("close", 0); });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl });
  await assert.rejects(() => service.speak("Text"), (error) => error.code === "PIPER_INVALID_OUTPUT");
});

test("terminates the child and rejects PIPER_OUTPUT_TOO_LARGE once stdout exceeds the byte cap", async () => {
  let terminated = false;
  const { impl } = fakeSpawn((child) => {
    child.stdout.emit("data", Buffer.alloc(JARVIS_SPEAK_MAX_AUDIO_BYTES + 1024, 1));
    // A well-behaved terminate would end the process; the fake simulates
    // that by not emitting close on its own - the service must resolve via
    // the oversized flag, not by waiting for a close event forced by us.
  });
  const terminateImpl = async (child) => { terminated = true; child.emit("close", null); };
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, terminateImpl });
  await assert.rejects(() => service.speak("Text"), (error) => error.code === "PIPER_OUTPUT_TOO_LARGE");
  assert.equal(terminated, true);
});

test("terminates the child and rejects PIPER_TIMEOUT when the timeout elapses", async () => {
  let terminated = false;
  const impl = () => fakeChild(); // never emits close on its own
  const terminateImpl = async (child) => { terminated = true; };
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, terminateImpl, timeoutMs: 5 });
  await assert.rejects(() => service.speak("Text"), (error) => error.code === "PIPER_TIMEOUT" && error.retryable === true);
  assert.equal(terminated, true);
});

test("does not throw when stdin emits an error (EPIPE guard)", async () => {
  const { impl } = fakeSpawn((child) => {
    child.stdin.emit("error", new Error("EPIPE"));
    child.stdout.emit("data", Buffer.from("RIFF"));
    child.emit("close", 0);
  });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl });
  const result = await service.speak("Text");
  assert.equal(result.audio.toString(), "RIFF");
});
