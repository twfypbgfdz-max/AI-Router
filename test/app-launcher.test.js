import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAppLauncher } from "../orchestrator/action/app-launcher.js";

// R6 - First Safe Executor. Unit tests for the one module allowed to start a
// Windows process. Every spawnImpl here is an injected fake - no test in
// this file ever touches a real process, matching the R6 spec's "kein
// Direktaufruf ... als vermeintlicher End-to-End-Test" boundary for the
// *unit* layer (the real end-to-end path is exercised separately, with a
// real spawnImpl, only by the manual smoke test).

function fakeChild() {
  const child = new EventEmitter();
  child.unref = () => {};
  return child;
}

function spawnThatSucceeds(calls) {
  return (exePath, args, options) => {
    calls.push({ exePath, args, options });
    const child = fakeChild();
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
}

function spawnThatFails(errorMessage = "ENOENT") {
  return () => {
    const child = fakeChild();
    queueMicrotask(() => child.emit("error", new Error(errorMessage)));
    return child;
  };
}

// --- allowlist ---------------------------------------------------------------

test("spotify is allowed and installed: launch succeeds with a structured result", async () => {
  const calls = [];
  const launcher = createAppLauncher({ spawnImpl: spawnThatSucceeds(calls), existsImpl: async () => true });
  const result = await launcher.launch("spotify");
  assert.deepEqual(result, { ok: true, app: "spotify", state: "opened" });
  assert.equal(calls.length, 1);
});

test("obsidian is allowed and installed: launch succeeds with a structured result", async () => {
  const calls = [];
  const launcher = createAppLauncher({ spawnImpl: spawnThatSucceeds(calls), existsImpl: async () => true });
  const result = await launcher.launch("obsidian");
  assert.deepEqual(result, { ok: true, app: "obsidian", state: "opened" });
});

test("an unknown target is rejected as APP_NOT_ALLOWED, never reaching spawn", async () => {
  const calls = [];
  const launcher = createAppLauncher({ spawnImpl: spawnThatSucceeds(calls), existsImpl: async () => true });
  await assert.rejects(launcher.launch("notepad"), { code: "APP_NOT_ALLOWED" });
  assert.equal(calls.length, 0, "spawn must never be reached for a target outside the fixed allowlist");
});

test("a caller-supplied executable-shaped string can never inject a launch target", async () => {
  const calls = [];
  const launcher = createAppLauncher({ spawnImpl: spawnThatSucceeds(calls), existsImpl: async () => true });
  for (const injected of ["C:\\Windows\\System32\\calc.exe", "spotify.exe", "../../evil.exe", "spotify; calc.exe"]) {
    await assert.rejects(launcher.launch(injected), { code: "APP_NOT_ALLOWED" });
  }
  assert.equal(calls.length, 0);
});

// --- installation detection ---------------------------------------------------

test("a registered but not-installed app fails closed as APP_NOT_INSTALLED, never spawning", async () => {
  const calls = [];
  const launcher = createAppLauncher({ spawnImpl: spawnThatSucceeds(calls), existsImpl: async () => false });
  await assert.rejects(launcher.launch("spotify"), { code: "APP_NOT_INSTALLED" });
  assert.equal(calls.length, 0);
});

// --- spawn safety: no shell, fixed args ---------------------------------------

test("spawn is always called with shell:false and a fixed, empty argument list", async () => {
  const calls = [];
  const launcher = createAppLauncher({ spawnImpl: spawnThatSucceeds(calls), existsImpl: async () => true });
  await launcher.launch("spotify");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].args, []);
  assert.match(calls[0].exePath, /Spotify\.exe$/);
});

test("the executable path is a fixed, code-defined absolute path, not caller-influenced", async () => {
  const calls = [];
  const launcher = createAppLauncher({ spawnImpl: spawnThatSucceeds(calls), existsImpl: async () => true });
  await launcher.launch("obsidian");
  assert.match(calls[0].exePath, /Obsidian\.exe$/);
  assert.ok(path_isAbsoluteLike(calls[0].exePath));
});

function path_isAbsoluteLike(value) {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

// --- launch failure normalization ----------------------------------------------

test("a real spawn error is normalized to APP_LAUNCH_FAILED, never a fabricated success", async () => {
  const launcher = createAppLauncher({ spawnImpl: spawnThatFails("EPERM"), existsImpl: async () => true });
  await assert.rejects(launcher.launch("spotify"), { code: "APP_LAUNCH_FAILED" });
});

test("a spawnImpl that throws synchronously is also normalized to APP_LAUNCH_FAILED", async () => {
  const launcher = createAppLauncher({
    spawnImpl: () => { throw new Error("boom"); },
    existsImpl: async () => true
  });
  await assert.rejects(launcher.launch("spotify"), { code: "APP_LAUNCH_FAILED" });
});

// --- fire-and-forget: unref is called on success --------------------------------

test("a successful launch detaches from the child (unref) so it never blocks process exit", async () => {
  let unrefCalled = false;
  const spawnImpl = () => {
    const child = fakeChild();
    child.unref = () => { unrefCalled = true; };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const launcher = createAppLauncher({ spawnImpl, existsImpl: async () => true });
  await launcher.launch("spotify");
  assert.equal(unrefCalled, true);
});
