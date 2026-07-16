import test from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_STATES, createAdapterStatusMonitor, isMockAdapterValid, projectAdapterStatus } from "../orchestrator/adapter-status.js";

function fakeClock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

test("adapter status starts unchecked before any probe", () => {
  const monitor = createAdapterStatusMonitor({ probeCodex: async () => ({ state: "available" }) });
  const current = monitor.current();
  assert.equal(current["codex-cli"].state, "unchecked");
  assert.equal(current.mock.state, "unchecked");
});

test("refresh resolves mock available and maps a codex available probe", async () => {
  const monitor = createAdapterStatusMonitor({ probeCodex: async () => ({ state: "available", safeErrorCode: null }) });
  const status = await monitor.refresh();
  assert.equal(status.mock.state, "available");
  assert.equal(status["codex-cli"].state, "available");
  assert.ok(status["codex-cli"].checkedAt);
});

test("refresh maps unsupported and unavailable codex results with safe codes", async () => {
  const unsupported = await createAdapterStatusMonitor({ probeCodex: async () => ({ state: "unsupported", safeErrorCode: "CODEX_CLI_UNSUPPORTED" }) }).refresh();
  assert.equal(unsupported["codex-cli"].state, "unsupported");
  assert.equal(unsupported["codex-cli"].safeErrorCode, "CODEX_CLI_UNSUPPORTED");
  const unavailable = await createAdapterStatusMonitor({ probeCodex: async () => ({ state: "unavailable", safeErrorCode: "CODEX_CLI_NOT_FOUND" }) }).refresh();
  assert.equal(unavailable["codex-cli"].state, "unavailable");
  assert.equal(unavailable["codex-cli"].safeErrorCode, "CODEX_CLI_NOT_FOUND");
});

test("a thrown probe degrades to a safe unavailable state", async () => {
  const monitor = createAdapterStatusMonitor({ probeCodex: async () => { throw new Error("boom"); } });
  const status = await monitor.refresh();
  assert.equal(status["codex-cli"].state, "unavailable");
  assert.equal(status["codex-cli"].safeErrorCode, "CODEX_PROCESS_START_FAILED");
  assert.equal(JSON.stringify(status).includes("boom"), false);
});

test("the codex probe is cached within the cache window and re-run only when forced", async () => {
  let probes = 0;
  const clock = fakeClock();
  const monitor = createAdapterStatusMonitor({ probeCodex: async () => { probes += 1; return { state: "available" }; }, cacheMs: 60_000, now: clock.now });
  await monitor.refresh();
  await monitor.refresh();
  assert.equal(probes, 1, "second refresh within cache window must not re-probe");
  clock.advance(60_001);
  await monitor.refresh();
  assert.equal(probes, 2, "refresh after cache window re-probes");
  await monitor.refresh({ force: true });
  assert.equal(probes, 3, "forced refresh always re-probes");
});

test("concurrent refresh calls share a single in-flight probe", async () => {
  let probes = 0;
  const monitor = createAdapterStatusMonitor({ probeCodex: async () => { probes += 1; await new Promise((r) => setTimeout(r, 20)); return { state: "available" }; } });
  await Promise.all([monitor.refresh(), monitor.refresh(), monitor.refresh()]);
  assert.equal(probes, 1);
});

test("mock counts as unavailable when its configuration is invalid", async () => {
  const monitor = createAdapterStatusMonitor({ probeCodex: async () => ({ state: "available" }), mockValid: () => false });
  const status = await monitor.refresh();
  assert.equal(status.mock.state, "unavailable");
});

test("the real mock adapter reports a valid configuration", () => {
  assert.equal(isMockAdapterValid(), true);
});

test("projectAdapterStatus keeps only safe state fields and defaults unknowns", () => {
  const projected = projectAdapterStatus({ mock: { state: "available", checkedAt: "2026-01-01T00:00:00.000Z", safeErrorCode: null, secretPath: "C:\\secret" }, "codex-cli": { state: "weird" } });
  assert.deepEqual(Object.keys(projected.mock).sort(), ["checkedAt", "safeErrorCode", "state"]);
  assert.equal(projected["codex-cli"].state, "unchecked");
  assert.equal(JSON.stringify(projected).includes("secret"), false);
  assert.ok(ADAPTER_STATES.includes(projected.mock.state));
});
