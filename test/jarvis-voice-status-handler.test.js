import test from "node:test";
import assert from "node:assert/strict";
import { createJarvisVoiceStatusHandler } from "../orchestrator/jarvis-voice-status-handler.js";

function response() {
  const res = {};
  res.headers = new Map();
  res.statusCode = 200;
  res.body = "";
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) res.headers.set(String(name).toLowerCase(), String(value));
    return res;
  };
  res.end = (v = "") => { res.body = String(v); };
  res.json = () => JSON.parse(res.body);
  return res;
}

test("responds 200 with schemaVersion plus the checked whisper/piper states, nothing else", async () => {
  const handler = createJarvisVoiceStatusHandler({ checkVoiceStatusFn: async () => Object.freeze({ whisper: "active", piper: "ready" }) });
  const res = response();
  await handler({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { schemaVersion: "1.0", whisper: "active", piper: "ready" });
});

test("passes the checked state through unchanged for every combination, no own interpretation", async () => {
  const handler = createJarvisVoiceStatusHandler({ checkVoiceStatusFn: async () => Object.freeze({ whisper: "configured", piper: "unavailable" }) });
  const res = response();
  await handler({}, res);
  const body = res.json();
  assert.equal(body.whisper, "configured");
  assert.equal(body.piper, "unavailable");
});

test("calls checkVoiceStatusFn exactly once per request", async () => {
  let calls = 0;
  const handler = createJarvisVoiceStatusHandler({ checkVoiceStatusFn: async () => { calls += 1; return { whisper: "unavailable", piper: "unavailable" }; } });
  await handler({}, response());
  assert.equal(calls, 1);
});
