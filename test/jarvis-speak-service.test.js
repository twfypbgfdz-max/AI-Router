import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createJarvisSpeakService } from "../orchestrator/jarvis-speak-service.js";
import { PIPER_BINARY_PATH_ENV_VAR, PIPER_VOICE_MODEL_PATH_ENV_VAR, JARVIS_SPEAK_MAX_AUDIO_BYTES } from "../orchestrator/jarvis-speak-config.js";

const CONFIGURED_ENV = {
  [PIPER_BINARY_PATH_ENV_VAR]: "C:\\fake\\piper.exe",
  [PIPER_VOICE_MODEL_PATH_ENV_VAR]: "C:\\fake\\voice.onnx"
};

// Regression test suite for the 2026-08-13 stdout-corruption bugfix: piper
// is now invoked with "-f <realFile>" (the verified-clean path), never
// "-f -" (stdout, confirmed corrupt on this Windows binary via two
// independent capture methods - see jarvis-speak-config.js). These tests
// therefore let the fake child process actually write bytes to the real
// output-file path the service passes it, then assert on what the service
// reads back and on whether it cleans the file up afterwards.

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.written = null;
  child.stdin.end = (text) => { child.stdin.written = text; };
  return child;
}

function outputFileFromArgs(args) {
  const index = args.indexOf("-f");
  return index === -1 ? null : args[index + 1];
}

function fakeSpawn(behavior) {
  const calls = [];
  const impl = (binaryPath, args, options) => {
    const child = fakeChild();
    const outputFile = outputFileFromArgs(args);
    calls.push({ binaryPath, args, options, child, outputFile });
    queueMicrotask(() => behavior(child, outputFile));
    return child;
  };
  return { impl, calls };
}

let tmpDir;
test.beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-speak-test-"));
});
test.afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

test("throws PIPER_NOT_CONFIGURED when either path is missing", async () => {
  const service = createJarvisSpeakService({ env: {}, spawnImpl: fakeSpawn(() => {}).impl, tmpDir });
  await assert.rejects(() => service.speak("Hallo"), (error) => error.code === "PIPER_NOT_CONFIGURED");
});

test("throws PIPER_NOT_CONFIGURED when only the binary path is set", async () => {
  const service = createJarvisSpeakService({
    env: { [PIPER_BINARY_PATH_ENV_VAR]: "C:\\fake\\piper.exe" },
    spawnImpl: fakeSpawn(() => {}).impl,
    tmpDir
  });
  await assert.rejects(() => service.speak("Hallo"), (error) => error.code === "PIPER_NOT_CONFIGURED");
});

test("spawns the configured binary with -m, -f <realFile>, -q (never -f -) and writes text to stdin", async () => {
  const { impl, calls } = fakeSpawn(async (child, outputFile) => {
    await fs.writeFile(outputFile, Buffer.from("RIFF....WAVEfmt "));
    child.emit("close", 0);
  });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, tmpDir });
  await service.speak("Wo liegt Felix Core?");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].binaryPath, "C:\\fake\\piper.exe");
  assert.equal(calls[0].args[0], "-m");
  assert.equal(calls[0].args[1], "C:\\fake\\voice.onnx");
  assert.equal(calls[0].args[2], "-f");
  assert.notEqual(calls[0].args[3], "-", "must never write to stdout - confirmed corrupt on this binary");
  assert.ok(calls[0].args[3].startsWith(tmpDir), "output file must live under the configured tmpDir");
  assert.equal(calls[0].args[4], "-q");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].child.stdin.written, "Wo liegt Felix Core?");
});

test("resolves with the exact bytes written to the temp file as the audio buffer", async () => {
  const { impl } = fakeSpawn(async (child, outputFile) => {
    await fs.writeFile(outputFile, Buffer.from("RIFF1234"));
    child.emit("close", 0);
  });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, tmpDir });
  const result = await service.speak("Text");
  assert.ok(Buffer.isBuffer(result.audio));
  assert.equal(result.audio.toString(), "RIFF1234");
});

test("deletes the temp file after a successful synthesis", async () => {
  let capturedPath = null;
  const { impl } = fakeSpawn(async (child, outputFile) => {
    capturedPath = outputFile;
    await fs.writeFile(outputFile, Buffer.from("RIFFDATA"));
    child.emit("close", 0);
  });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, tmpDir });
  await service.speak("Text");
  await assert.rejects(() => fs.access(capturedPath), "temp file must not survive the request");
});

test("deletes the temp file even when the service call fails", async () => {
  let capturedPath = null;
  const { impl } = fakeSpawn(async (child, outputFile) => {
    capturedPath = outputFile;
    await fs.writeFile(outputFile, Buffer.alloc(0));
    child.emit("close", 0); // exit 0 but empty file -> PIPER_INVALID_OUTPUT
  });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, tmpDir });
  await assert.rejects(() => service.speak("Text"));
  await assert.rejects(() => fs.access(capturedPath), "temp file must be cleaned up even on failure");
});

test("maps a spawn failure to PIPER_UNAVAILABLE, retryable", async () => {
  const impl = () => { throw new Error("ENOENT"); };
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, tmpDir });
  await assert.rejects(() => service.speak("Text"), (error) => error.code === "PIPER_UNAVAILABLE" && error.retryable === true);
});

test("maps a process 'error' event to PIPER_UNAVAILABLE", async () => {
  const { impl } = fakeSpawn((child) => { child.emit("error", new Error("spawn failed")); });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, tmpDir });
  await assert.rejects(() => service.speak("Text"), (error) => error.code === "PIPER_UNAVAILABLE");
});

test("maps a non-zero exit code to PIPER_FAILED, retryable", async () => {
  const { impl } = fakeSpawn((child) => { child.emit("close", 1); });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, tmpDir });
  await assert.rejects(() => service.speak("Text"), (error) => error.code === "PIPER_FAILED" && error.retryable === true);
});

test("maps a missing output file with exit code 0 to PIPER_INVALID_OUTPUT", async () => {
  const { impl } = fakeSpawn((child) => { child.emit("close", 0); }); // never writes the file
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, tmpDir });
  await assert.rejects(() => service.speak("Text"), (error) => error.code === "PIPER_INVALID_OUTPUT");
});

test("maps an empty output file with exit code 0 to PIPER_INVALID_OUTPUT", async () => {
  const { impl } = fakeSpawn(async (child, outputFile) => {
    await fs.writeFile(outputFile, Buffer.alloc(0));
    child.emit("close", 0);
  });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, tmpDir });
  await assert.rejects(() => service.speak("Text"), (error) => error.code === "PIPER_INVALID_OUTPUT");
});

test("rejects PIPER_OUTPUT_TOO_LARGE when the written file exceeds the byte cap, without reading it into memory first", async () => {
  const { impl } = fakeSpawn(async (child, outputFile) => {
    await fs.writeFile(outputFile, Buffer.alloc(JARVIS_SPEAK_MAX_AUDIO_BYTES + 1024, 1));
    child.emit("close", 0);
  });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, tmpDir });
  await assert.rejects(() => service.speak("Text"), (error) => error.code === "PIPER_OUTPUT_TOO_LARGE");
});

test("terminates the child and rejects PIPER_TIMEOUT when the timeout elapses", async () => {
  let terminated = false;
  const impl = () => fakeChild(); // never emits close on its own
  const terminateImpl = async () => { terminated = true; };
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, terminateImpl, timeoutMs: 5, tmpDir });
  await assert.rejects(() => service.speak("Text"), (error) => error.code === "PIPER_TIMEOUT" && error.retryable === true);
  assert.equal(terminated, true);
});

test("does not throw when stdin emits an error (EPIPE guard)", async () => {
  const { impl } = fakeSpawn(async (child, outputFile) => {
    child.stdin.emit("error", new Error("EPIPE"));
    await fs.writeFile(outputFile, Buffer.from("RIFF"));
    child.emit("close", 0);
  });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, tmpDir });
  const result = await service.speak("Text");
  assert.equal(result.audio.toString(), "RIFF");
});

test("creates the configured tmpDir if it does not exist yet", async () => {
  const nestedDir = path.join(tmpDir, "does", "not", "exist", "yet");
  const { impl } = fakeSpawn(async (child, outputFile) => {
    await fs.writeFile(outputFile, Buffer.from("RIFF"));
    child.emit("close", 0);
  });
  const service = createJarvisSpeakService({ env: CONFIGURED_ENV, spawnImpl: impl, tmpDir: nestedDir });
  const result = await service.speak("Text");
  assert.equal(result.audio.toString(), "RIFF");
});
