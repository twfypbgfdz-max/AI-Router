import test from "node:test";
import assert from "node:assert/strict";
import { parseOllamaLoopbackUrl } from "../orchestrator/ollama-loopback.js";

test("127.0.0.1, localhost and ::1 are accepted, with or without an explicit port", () => {
  assert.equal(parseOllamaLoopbackUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(parseOllamaLoopbackUrl("http://localhost:11434"), "http://localhost:11434");
  assert.equal(parseOllamaLoopbackUrl("http://[::1]:11434"), "http://[::1]:11434");
  assert.equal(parseOllamaLoopbackUrl("http://localhost"), "http://localhost");
});

test("an external hostname is rejected", () => {
  assert.equal(parseOllamaLoopbackUrl("http://evil.example.com:11434"), null);
});

test("a private-LAN IP address is rejected", () => {
  assert.equal(parseOllamaLoopbackUrl("http://192.168.1.5:11434"), null);
  assert.equal(parseOllamaLoopbackUrl("http://10.0.0.5:11434"), null);
  assert.equal(parseOllamaLoopbackUrl("http://169.254.1.1:11434"), null);
});

test("a public IP address is rejected", () => {
  assert.equal(parseOllamaLoopbackUrl("http://8.8.8.8:11434"), null);
});

test("credentials in the URL are rejected", () => {
  assert.equal(parseOllamaLoopbackUrl("http://user:pass@localhost:11434"), null);
  assert.equal(parseOllamaLoopbackUrl("http://user@localhost:11434"), null);
});

test("a query string is rejected", () => {
  assert.equal(parseOllamaLoopbackUrl("http://localhost:11434?x=1"), null);
});

test("a fragment is rejected", () => {
  assert.equal(parseOllamaLoopbackUrl("http://localhost:11434#frag"), null);
});

test("an unexpected non-root path is rejected", () => {
  assert.equal(parseOllamaLoopbackUrl("http://localhost:11434/api/tags"), null);
  assert.equal(parseOllamaLoopbackUrl("http://localhost:11434/../etc/passwd"), null);
});

test("https and any other protocol are rejected - only plain loopback http is allowed", () => {
  assert.equal(parseOllamaLoopbackUrl("https://localhost:11434"), null);
  assert.equal(parseOllamaLoopbackUrl("ftp://localhost:11434"), null);
});

test("malformed input fails closed to null", () => {
  assert.equal(parseOllamaLoopbackUrl("not a url"), null);
  assert.equal(parseOllamaLoopbackUrl(""), null);
  assert.equal(parseOllamaLoopbackUrl(undefined), null);
  assert.equal(parseOllamaLoopbackUrl(null), null);
});
