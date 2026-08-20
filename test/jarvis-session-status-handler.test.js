import test from "node:test";
import assert from "node:assert/strict";
import { createJarvisSessionStatusHandler } from "../orchestrator/jarvis-session-status-handler.js";
import { createSessionStore } from "../orchestrator/session/session-store.js";

function response() {
  const res = {};
  res.headers = new Map();
  res.statusCode = 200;
  res.setHeader = (n, v) => res.headers.set(String(n).toLowerCase(), String(v));
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    return res;
  };
  res.end = (v = "") => { res.body = String(v); };
  res.json = () => JSON.parse(res.body);
  return res;
}

test("reports activeSessions and the closed limit set, no session content", async () => {
  const sessionStore = createSessionStore();
  await sessionStore.appendTurn("11111111-1111-4111-8111-111111111111", { question: "geheime Frage", answer: "geheime Antwort" });
  const handler = createJarvisSessionStatusHandler({ sessionStore });
  const res = response();
  await handler({}, res);
  const payload = res.json();
  assert.equal(payload.activeSessions, 1);
  assert.equal(typeof payload.limits.maxTurns, "number");
  assert.equal(typeof payload.limits.idleTtlMs, "number");
  assert.equal(JSON.stringify(payload).includes("geheime"), false, "no session content may leak into the diagnostic endpoint");
});
