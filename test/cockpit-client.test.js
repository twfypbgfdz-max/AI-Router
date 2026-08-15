import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchCockpitStatus,
  COCKPIT_BASE_URL_ENV_VAR,
  COCKPIT_READ_TOKEN_ENV_VAR
} from "../orchestrator/cockpit-client.js";

const ENV = { [COCKPIT_BASE_URL_ENV_VAR]: "https://cockpit.example.test", [COCKPIT_READ_TOKEN_ENV_VAR]: "test-read-token" };

function jsonResponse(body, { status = 200, contentType = "application/json" } = {}) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : name.toLowerCase() === "content-length" ? String(Buffer.byteLength(text)) : null) },
    text: async () => text
  };
}

function fullStatusPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-15T08:00:00.000Z",
    services: {
      dailyState: { status: "ok", stale: false, updatedAt: "2026-08-15T07:00:00.000Z", data: { state: { schemaVersion: 1, date: "2026-08-15", focus: [{ id: "f1", text: "Plateau-Brecher testen", done: false }], updatedAt: "2026-08-15T07:00:00.000Z" } } },
      tasks: { status: "ok", stale: false, updatedAt: "2026-08-15T07:00:00.000Z", data: { state: { schemaVersion: 1, tasks: [{ id: "t1", text: "Reindex prüfen", dueDate: "2026-08-15", project: "AI-Router", priority: "high", status: "open", done: false, createdAt: "2026-08-01T00:00:00.000Z", completedAt: "", source: "manual", pinnedToday: true, blocked: false, blockerReason: "", estimatedMinutes: 30 }] } } },
      calendar: { status: "ok", stale: false, updatedAt: "2026-08-15T07:00:00.000Z", data: { events: [{ title: "Standup", start: "2026-08-15T09:00:00.000Z", end: "2026-08-15T09:15:00.000Z", allDay: false }] } },
      training: { status: "ok", stale: false, updatedAt: "", data: {} },
      ...overrides
    }
  };
}

test("unconfigured when base URL or token is missing", async () => {
  const result = await fetchCockpitStatus({ env: {}, fetchImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(result.state, "unconfigured");
  assert.equal(result.dailyState, null);
});

test("success: normalizes dailyState, tasks and calendar sections", async () => {
  let calledUrl;
  let calledHeaders;
  const result = await fetchCockpitStatus({
    env: ENV,
    fetchImpl: async (url, init) => {
      calledUrl = url;
      calledHeaders = init.headers;
      return jsonResponse(fullStatusPayload());
    }
  });
  assert.equal(result.state, "ok");
  assert.equal(calledUrl, "https://cockpit.example.test/api/cockpit-status");
  assert.equal(calledHeaders.authorization, "Bearer test-read-token");
  assert.equal(result.dailyState.status, "ok");
  assert.equal(result.dailyState.date, "2026-08-15");
  assert.equal(result.dailyState.focus.length, 1);
  assert.equal(result.dailyState.focus[0].text, "Plateau-Brecher testen");
  assert.equal(result.tasks.tasks.length, 1);
  assert.equal(result.tasks.tasks[0].text, "Reindex prüfen");
  assert.equal(result.calendar.events.length, 1);
  assert.equal(result.calendar.events[0].title, "Standup");
});

test("training/github/news/aiRouter sections are never read", async () => {
  const result = await fetchCockpitStatus({
    env: ENV,
    fetchImpl: async () => jsonResponse(fullStatusPayload())
  });
  assert.deepEqual(Object.keys(result).sort(), ["calendar", "dailyState", "generatedAt", "state", "tasks"]);
});

test("timeout yields unavailable, never throws", async () => {
  const result = await fetchCockpitStatus({
    env: ENV,
    timeoutMs: 5,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })
  });
  assert.equal(result.state, "unavailable");
});

test("wrong content type is rejected fail-closed", async () => {
  const result = await fetchCockpitStatus({
    env: ENV,
    fetchImpl: async () => jsonResponse(fullStatusPayload(), { contentType: "text/html" })
  });
  assert.equal(result.state, "unavailable");
});

test("invalid JSON body is rejected fail-closed", async () => {
  const result = await fetchCockpitStatus({
    env: ENV,
    fetchImpl: async () => ({
      ok: true,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => "{not valid json"
    })
  });
  assert.equal(result.state, "unavailable");
});

test("oversized body (declared content-length) is rejected fail-closed", async () => {
  const result = await fetchCockpitStatus({
    env: ENV,
    maxBodyBytes: 10,
    fetchImpl: async () => ({
      ok: true,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : name.toLowerCase() === "content-length" ? "100000" : null) },
      body: { cancel: async () => {} },
      text: async () => JSON.stringify(fullStatusPayload())
    })
  });
  assert.equal(result.state, "unavailable");
});

test("non-2xx response is unavailable", async () => {
  const result = await fetchCockpitStatus({
    env: ENV,
    fetchImpl: async () => ({ ok: false, headers: { get: () => null }, text: async () => "" })
  });
  assert.equal(result.state, "unavailable");
});

test("network error is unavailable, never throws", async () => {
  const result = await fetchCockpitStatus({
    env: ENV,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); }
  });
  assert.equal(result.state, "unavailable");
});

test("a section reporting unconfigured/error/empty is passed through, not fabricated", async () => {
  const result = await fetchCockpitStatus({
    env: ENV,
    fetchImpl: async () => jsonResponse(fullStatusPayload({
      dailyState: { status: "unconfigured", stale: false, updatedAt: "", data: null },
      tasks: { status: "error", stale: false, updatedAt: "", data: null }
    }))
  });
  assert.equal(result.state, "ok");
  assert.equal(result.dailyState.status, "unconfigured");
  assert.equal(result.dailyState.focus.length, 0);
  assert.equal(result.tasks.status, "error");
});

test("a malformed focus item is dropped, not passed through", async () => {
  const result = await fetchCockpitStatus({
    env: ENV,
    fetchImpl: async () => jsonResponse(fullStatusPayload({
      dailyState: { status: "ok", stale: false, updatedAt: "2026-08-15T07:00:00.000Z", data: { state: { date: "2026-08-15", focus: [{ id: "f1", text: 123, done: false }] } } }
    }))
  });
  assert.equal(result.dailyState.focus.length, 0);
});
