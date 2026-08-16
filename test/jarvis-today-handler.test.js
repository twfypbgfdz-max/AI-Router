import test from "node:test";
import assert from "node:assert/strict";
import { createJarvisTodayHandler } from "../orchestrator/jarvis-today-handler.js";
import { COCKPIT_BASE_URL_ENV_VAR, COCKPIT_READ_TOKEN_ENV_VAR } from "../orchestrator/cockpit-client.js";

// buildJarvisDailyContext() (unchanged, reused as-is) computes "today" from
// the real system clock - it is not given a fixed `now` by this handler, so
// tests match against the real current date instead of a hardcoded one to
// stay correct regardless of when they run.
const TODAY = new Date().toISOString().slice(0, 10);

function fullEnv(overrides = {}) {
  return {
    [COCKPIT_BASE_URL_ENV_VAR]: "https://cockpit.example.test",
    [COCKPIT_READ_TOKEN_ENV_VAR]: "cockpit-read-token",
    ...overrides
  };
}

function response() {
  const res = new (class extends Object {})();
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

function jsonFetch(payload, { ok = true } = {}) {
  return async () => ({
    ok,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify(payload)
  });
}

// --- fail-closed behaviour -----------------------------------------------

test("GET /api/jarvis/today reports cockpitState 'unconfigured' and context null when the env is not set, never throws", async () => {
  const handler = createJarvisTodayHandler({ env: {}, fetchImpl: async () => { throw new Error("must not be called"); } });
  const res = response();
  await handler({}, res);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schemaVersion, "1.0");
  assert.equal(body.cockpitState, "unconfigured");
  assert.equal(body.context, null);
});

test("reports cockpitState 'unavailable' and context null when Cockpit cannot be reached", async () => {
  const handler = createJarvisTodayHandler({
    env: fullEnv(),
    fetchImpl: async () => { throw new Error("network down"); }
  });
  const res = response();
  await handler({}, res);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.cockpitState, "unavailable");
  assert.equal(body.context, null);
});

test("reports context null (not a thrown error) when Cockpit answers but has nothing usable for any section", async () => {
  const handler = createJarvisTodayHandler({
    env: fullEnv(),
    fetchImpl: jsonFetch({
      schemaVersion: 1,
      generatedAt: "2026-08-16T08:00:00.000Z",
      services: {
        dailyState: { status: "unconfigured", stale: false, updatedAt: "", data: null },
        tasks: { status: "unconfigured", stale: false, updatedAt: "", data: null },
        calendar: { status: "unconfigured", stale: false, updatedAt: "", data: null }
      }
    })
  });
  const res = response();
  await handler({}, res);
  const body = res.json();
  assert.equal(body.cockpitState, "ok");
  assert.equal(body.context, null);
});

// --- reuse of the existing operational-context path -----------------------

test("returns focus, tasks and calendar built by the exact same functions the knowledge path already uses", async () => {
  const handler = createJarvisTodayHandler({
    env: fullEnv(),
    fetchImpl: jsonFetch({
      schemaVersion: 1,
      generatedAt: `${TODAY}T08:00:00.000Z`,
      services: {
        dailyState: { status: "ok", stale: false, updatedAt: `${TODAY}T07:00:00.000Z`, data: { state: { date: TODAY, focus: [{ id: "f1", text: "Plateau-Brecher testen", done: false }] } } },
        tasks: { status: "ok", stale: false, updatedAt: `${TODAY}T07:00:00.000Z`, data: { state: { tasks: [{ text: "Review vorbereiten", status: "open", priority: "", dueDate: "", project: "", blocked: false }] } } },
        calendar: { status: "unconfigured", stale: false, updatedAt: "", data: null }
      }
    })
  });
  const res = response();
  await handler({}, res);
  const body = res.json();
  assert.equal(body.cockpitState, "ok");
  assert.ok(body.context);
  assert.equal(body.context.today, TODAY);
  assert.equal(body.context.focus.freshness, "fresh");
  assert.deepEqual(body.context.focus.items, [{ text: "Plateau-Brecher testen", done: false }]);
  assert.equal(body.context.tasks.items[0].text, "Review vorbereiten");
  // calendar was requested (FULL_DAY_INTENT always sets needsCalendar) but
  // Cockpit itself has no calendar section configured - a block object with
  // freshness "unconfigured", not null (null only happens when a block was
  // never requested at all, which this route never does).
  assert.equal(body.context.calendar.freshness, "unconfigured");
});

// --- this route requests every section, unlike the intent-gated ask path --

test("always requests all three sections (focus, tasks, calendar) - a fixed intent, not derived from any question", async () => {
  const handler = createJarvisTodayHandler({
    env: fullEnv(),
    fetchImpl: jsonFetch({
      schemaVersion: 1,
      generatedAt: `${TODAY}T08:00:00.000Z`,
      services: {
        // Focus freshness "empty" requires status "ok" with a matching date
        // and zero items - normalizeDailyStateSection() sets date to null
        // for any non-ok/non-stale status, which buildFocusBlock's own
        // date-staleness check would otherwise read as "stale", not "empty".
        dailyState: { status: "ok", stale: false, updatedAt: `${TODAY}T07:00:00.000Z`, data: { state: { date: TODAY, focus: [] } } },
        tasks: { status: "empty", stale: false, updatedAt: `${TODAY}T07:00:00.000Z`, data: { state: { tasks: [] } } },
        calendar: { status: "empty", stale: false, updatedAt: `${TODAY}T07:00:00.000Z`, data: { events: [] } }
      }
    })
  });
  const res = response();
  await handler({}, res);
  const body = res.json();
  // "empty" blocks are still usable (a real, deliberate "nothing today" -
  // see buildJarvisDailyContext's USABLE_FRESHNESS set), so all three block
  // objects must be present, not skipped.
  assert.equal(body.context.focus.freshness, "empty");
  assert.equal(body.context.tasks.freshness, "empty");
  assert.equal(body.context.calendar.freshness, "empty");
});

// --- no write path, no new data source -------------------------------------

test("never sends anything but a GET-shaped read to Cockpit - no body, no mutation intent", async () => {
  let seenInit = null;
  const handler = createJarvisTodayHandler({
    env: fullEnv(),
    fetchImpl: async (_url, init) => {
      seenInit = init;
      return {
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
        text: async () => JSON.stringify({ schemaVersion: 1, generatedAt: "2026-08-16T08:00:00.000Z", services: {} })
      };
    }
  });
  await handler({}, response());
  assert.equal(seenInit.method, "GET");
  assert.equal(seenInit.body, undefined);
});

test("response never carries the Cockpit read token", async () => {
  const handler = createJarvisTodayHandler({
    env: fullEnv({ [COCKPIT_READ_TOKEN_ENV_VAR]: "super-secret-token" }),
    fetchImpl: jsonFetch({ schemaVersion: 1, generatedAt: "2026-08-16T08:00:00.000Z", services: {} })
  });
  const res = response();
  await handler({}, res);
  assert.ok(!res.body.includes("super-secret-token"));
});
