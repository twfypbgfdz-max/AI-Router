import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createJarvisTranscribeHandler } from "../orchestrator/jarvis-transcribe-handler.js";
import { JarvisTranscribeError } from "../orchestrator/jarvis-transcribe-error.js";
import { JARVIS_TRANSCRIBE_MAX_AUDIO_BYTES } from "../orchestrator/jarvis-transcribe-config.js";

function request({ method = "POST", contentType = "audio/wav", body = Buffer.from([1, 2, 3]) } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { "content-type": contentType };
  req.destroy = () => {};
  queueMicrotask(() => {
    if (Buffer.isBuffer(body)) {
      req.emit("data", body);
    } else if (Array.isArray(body)) {
      for (const chunk of body) req.emit("data", chunk);
    }
    req.emit("end");
  });
  return req;
}

function response() {
  const res = new EventEmitter();
  res.headers = new Map();
  res.statusCode = 200;
  res.body = "";
  res.setHeader = (n, v) => res.headers.set(String(n).toLowerCase(), String(v));
  res.getHeader = (n) => res.headers.get(String(n).toLowerCase());
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    return res;
  };
  res.end = (v = "") => { res.body = String(v); };
  res.json = () => JSON.parse(res.body);
  return res;
}

function fakeService(transcribeFn) {
  return { transcribe: transcribeFn };
}

test("rejects a non-POST method", async () => {
  const handler = createJarvisTranscribeHandler({ service: fakeService(async () => { throw new Error("must not be called"); }) });
  const res = response();
  await handler(request({ method: "GET" }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.json().error.code, "METHOD_NOT_ALLOWED");
});

test("rejects a non-audio content-type without touching the service", async () => {
  let called = false;
  const handler = createJarvisTranscribeHandler({ service: fakeService(async () => { called = true; return { text: "x" }; }) });
  const res = response();
  await handler(request({ contentType: "application/json" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "INVALID_REQUEST");
  assert.equal(called, false);
});

test("rejects an empty body", async () => {
  const handler = createJarvisTranscribeHandler({ service: fakeService(async () => ({ text: "x" })) });
  const res = response();
  await handler(request({ body: Buffer.alloc(0) }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "INVALID_REQUEST");
});

test("rejects a body larger than the configured byte cap", async () => {
  let called = false;
  const oversized = Buffer.alloc(JARVIS_TRANSCRIBE_MAX_AUDIO_BYTES + 1024, 7);
  const handler = createJarvisTranscribeHandler({ service: fakeService(async () => { called = true; return { text: "x" }; }) });
  const res = response();
  await handler(request({ body: oversized }), res);
  assert.equal(res.statusCode, 413);
  assert.equal(res.json().error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(called, false);
});

test("passes the audio buffer and content-type through to the service", async () => {
  let seen = null;
  const handler = createJarvisTranscribeHandler({
    service: fakeService(async (args) => { seen = args; return { text: "Wo liegt Felix Core?" }; })
  });
  const res = response();
  await handler(request({ body: Buffer.from([1, 2, 3, 4]), contentType: "audio/wav" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { schemaVersion: "1.0", text: "Wo liegt Felix Core?" });
  assert.ok(Buffer.isBuffer(seen.audio));
  assert.deepEqual([...seen.audio], [1, 2, 3, 4]);
  assert.equal(seen.contentType, "audio/wav");
});

test("maps a JarvisTranscribeError from the service to its own status and code", async () => {
  const handler = createJarvisTranscribeHandler({
    service: fakeService(async () => { throw new JarvisTranscribeError("WHISPER_NOT_CONFIGURED", "no server"); })
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, "WHISPER_NOT_CONFIGURED");
});

test("maps an unexpected service error to a safe INTERNAL_ERROR without leaking its message", async () => {
  const handler = createJarvisTranscribeHandler({
    service: fakeService(async () => { throw new Error("some internal stack trace detail"); })
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error.code, "INTERNAL_ERROR");
  assert.ok(!res.body.includes("stack trace"));
});

test("every response carries the schema version", async () => {
  const handler = createJarvisTranscribeHandler({ service: fakeService(async () => ({ text: "ok" })) });
  const res = response();
  await handler(request(), res);
  assert.equal(res.json().schemaVersion, "1.0");
});
