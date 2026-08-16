import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createJarvisSpeakHandler } from "../orchestrator/jarvis-speak-handler.js";
import { JarvisSpeakError } from "../orchestrator/jarvis-speak-error.js";
import { JARVIS_SPEAK_MAX_TEXT_CHARS } from "../orchestrator/jarvis-speak-config.js";

function request({ method = "POST", body = { text: "Hallo Welt" } } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { "content-type": "application/json" };
  req.destroy = () => {};
  queueMicrotask(() => {
    req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function response() {
  const res = new EventEmitter();
  res.headers = new Map();
  res.statusCode = 200;
  res.body = null;
  res.setHeader = (n, v) => res.headers.set(String(n).toLowerCase(), String(v));
  res.getHeader = (n) => res.headers.get(String(n).toLowerCase());
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    return res;
  };
  res.end = (v) => { res.body = v; };
  res.json = () => JSON.parse(res.body.toString());
  return res;
}

function fakeService(speakFn) {
  return { speak: speakFn };
}

test("rejects a non-POST method", async () => {
  const handler = createJarvisSpeakHandler({ service: fakeService(async () => { throw new Error("must not be called"); }) });
  const res = response();
  await handler(request({ method: "GET" }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.json().error.code, "METHOD_NOT_ALLOWED");
});

test("rejects a body with no text field", async () => {
  let called = false;
  const handler = createJarvisSpeakHandler({ service: fakeService(async () => { called = true; return { audio: Buffer.from("x") }; }) });
  const res = response();
  await handler(request({ body: { notText: true } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "INVALID_REQUEST");
  assert.equal(called, false);
});

test("rejects an empty or whitespace-only text", async () => {
  const handler = createJarvisSpeakHandler({ service: fakeService(async () => ({ audio: Buffer.from("x") })) });
  const res = response();
  await handler(request({ body: { text: "   " } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "INVALID_REQUEST");
});

test("rejects text longer than the configured character cap", async () => {
  let called = false;
  const tooLong = "a".repeat(JARVIS_SPEAK_MAX_TEXT_CHARS + 1);
  const handler = createJarvisSpeakHandler({ service: fakeService(async () => { called = true; return { audio: Buffer.from("x") }; }) });
  const res = response();
  await handler(request({ body: { text: tooLong } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "INVALID_REQUEST");
  assert.equal(called, false);
});

test("rejects malformed JSON", async () => {
  const handler = createJarvisSpeakHandler({ service: fakeService(async () => ({ audio: Buffer.from("x") })) });
  const res = response();
  await handler(request({ body: "{ kaputt" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "INVALID_REQUEST");
});

test("passes the trimmed text through to the service", async () => {
  let seen = null;
  const handler = createJarvisSpeakHandler({ service: fakeService(async (text) => { seen = text; return { audio: Buffer.from("RIFF") }; }) });
  await handler(request({ body: { text: "  Wo liegt Felix Core?  " } }), response());
  assert.equal(seen, "Wo liegt Felix Core?");
});

// DEC-008: normalizeForSpeech is applied between trim() and service.speak().
// The test above already proves the identity case (no markers/paths - no
// change); this proves the transformation actually happens at the handler,
// not only in isolation in jarvis-speak-normalize.test.js.
test("normalizes source markers and relative vault paths before calling the service", async () => {
  let seen = null;
  const handler = createJarvisSpeakHandler({ service: fakeService(async (text) => { seen = text; return { audio: Buffer.from("RIFF") }; }) });
  const dirty = "Laut [K1] steht das in 10_Apps/90_Entscheidungen/DEC-006-Felix-Core-Vertragsebene.md.";
  await handler(request({ body: { text: dirty } }), response());
  assert.ok(!seen.includes("[K1]"));
  assert.ok(!seen.includes(".md"));
  assert.equal(seen, "Laut steht das in.");
});

test("returns the audio buffer as audio/wav with no JSON envelope", async () => {
  const handler = createJarvisSpeakHandler({ service: fakeService(async () => ({ audio: Buffer.from("RIFFDATA") })) });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader("content-type"), "audio/wav");
  assert.equal(res.getHeader("cache-control"), "no-store");
  assert.equal(Buffer.isBuffer(res.body) ? res.body.toString() : res.body, "RIFFDATA");
});

test("maps a JarvisSpeakError from the service to its own status and code", async () => {
  const handler = createJarvisSpeakHandler({
    service: fakeService(async () => { throw new JarvisSpeakError("PIPER_NOT_CONFIGURED", "no engine"); })
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, "PIPER_NOT_CONFIGURED");
});

test("maps PIPER_TIMEOUT to 504", async () => {
  const handler = createJarvisSpeakHandler({
    service: fakeService(async () => { throw new JarvisSpeakError("PIPER_TIMEOUT", "too slow", { retryable: true }); })
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 504);
});

test("maps an unexpected service error to a safe INTERNAL_ERROR without leaking its message", async () => {
  const handler = createJarvisSpeakHandler({
    service: fakeService(async () => { throw new Error("some internal stack trace detail"); })
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 500);
  const parsed = res.json();
  assert.equal(parsed.error.code, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(parsed).includes("stack trace"));
});

test("every JSON error response carries the schema version", async () => {
  const handler = createJarvisSpeakHandler({ service: fakeService(async () => { throw new JarvisSpeakError("PIPER_FAILED", "x"); }) });
  const res = response();
  await handler(request(), res);
  assert.equal(res.json().schemaVersion, "1.0");
});
