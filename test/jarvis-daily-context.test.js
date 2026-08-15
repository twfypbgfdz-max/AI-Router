import test from "node:test";
import assert from "node:assert/strict";
import { buildJarvisDailyContext } from "../orchestrator/jarvis-daily-context.js";
import { matchJarvisDailyIntent } from "../orchestrator/jarvis-daily-intent.js";

const NOW = () => new Date("2026-08-15T10:00:00.000Z");

function cockpitOk(overrides = {}) {
  return Object.freeze({
    state: "ok",
    generatedAt: "2026-08-15T10:00:00.000Z",
    dailyState: Object.freeze({ status: "ok", stale: false, date: "2026-08-15", focus: Object.freeze([{ text: "A", done: false }, { text: "B", done: true }]) }),
    tasks: Object.freeze({
      status: "ok",
      stale: false,
      tasks: Object.freeze([
        { text: "overdue task", status: "open", priority: "high", dueDate: "2026-08-10", project: "", blocked: false },
        { text: "due today", status: "open", priority: "medium", dueDate: "2026-08-15", project: "", blocked: false },
        { text: "blocked task", status: "blocked", priority: "", dueDate: "", project: "", blocked: true },
        { text: "done task", status: "completed", priority: "", dueDate: "", project: "", blocked: false }
      ])
    }),
    calendar: Object.freeze({
      status: "ok",
      stale: false,
      events: Object.freeze([
        { title: "Today event", start: "2026-08-15T09:00:00.000Z", end: "2026-08-15T09:30:00.000Z", allDay: false, location: null },
        { title: "Tomorrow event", start: "2026-08-16T09:00:00.000Z", end: "2026-08-16T09:30:00.000Z", allDay: false, location: null }
      ])
    }),
    ...overrides
  });
}

test("returns null when cockpit is unreachable", () => {
  const intent = matchJarvisDailyIntent("Was ist mein Fokus?");
  const context = buildJarvisDailyContext({ cockpitStatus: { state: "unavailable" }, intent, now: NOW });
  assert.equal(context, null);
});

test("returns null when cockpit is unconfigured", () => {
  const intent = matchJarvisDailyIntent("Was ist mein Fokus?");
  const context = buildJarvisDailyContext({ cockpitStatus: { state: "unconfigured" }, intent, now: NOW });
  assert.equal(context, null);
});

test("focus-only question only fetches/renders the focus block", () => {
  const intent = matchJarvisDailyIntent("Was ist mein Fokus?");
  const context = buildJarvisDailyContext({ cockpitStatus: cockpitOk(), intent, now: NOW });
  assert.ok(context);
  assert.ok(context.focus);
  assert.equal(context.tasks, null);
  assert.equal(context.calendar, null);
  assert.equal(context.focus.items.length, 2);
});

test("open tasks are prioritized (blocked/overdue first) and capped at 8", () => {
  const manyTasks = Array.from({ length: 12 }, (_, i) => ({ text: `task-${i}`, status: "open", priority: "", dueDate: "", project: "", blocked: false }));
  const intent = matchJarvisDailyIntent("Was sind meine offenen Aufgaben?");
  const context = buildJarvisDailyContext({
    cockpitStatus: cockpitOk({ tasks: Object.freeze({ status: "ok", stale: false, tasks: Object.freeze(manyTasks) }) }),
    intent,
    now: NOW
  });
  assert.equal(context.tasks.items.length, 8);
});

test("overdue and blocked tasks rank before a plain open task", () => {
  const intent = matchJarvisDailyIntent("Was sind meine offenen Aufgaben?");
  const context = buildJarvisDailyContext({ cockpitStatus: cockpitOk(), intent, now: NOW });
  const texts = context.tasks.items.map((t) => t.text);
  assert.ok(texts.indexOf("blocked task") < texts.indexOf("due today"));
  assert.ok(texts.indexOf("overdue task") < texts.indexOf("due today"));
  assert.equal(texts.includes("done task"), false);
});

test("done-view only returns completed tasks", () => {
  const intent = matchJarvisDailyIntent("Was habe ich heute erledigt?");
  const context = buildJarvisDailyContext({ cockpitStatus: cockpitOk(), intent, now: NOW });
  assert.deepEqual(context.tasks.items.map((t) => t.text), ["done task"]);
});

test("calendar is filtered to today and capped at 5", () => {
  const intent = matchJarvisDailyIntent("Welche Termine habe ich heute?");
  const context = buildJarvisDailyContext({ cockpitStatus: cockpitOk(), intent, now: NOW });
  assert.equal(context.calendar.items.length, 1);
  assert.equal(context.calendar.items[0].title, "Today event");
});

test("a stale daily-state section is marked stale, not silently fresh", () => {
  const intent = matchJarvisDailyIntent("Was ist mein Fokus?");
  const context = buildJarvisDailyContext({
    cockpitStatus: cockpitOk({ dailyState: Object.freeze({ status: "stale", stale: true, date: "2026-08-14", focus: Object.freeze([{ text: "old", done: false }]) }) }),
    intent,
    now: NOW
  });
  assert.equal(context.focus.freshness, "stale");
});

test("a daily-state dated a different day than today is treated as stale", () => {
  const intent = matchJarvisDailyIntent("Was ist mein Fokus?");
  const context = buildJarvisDailyContext({
    cockpitStatus: cockpitOk({ dailyState: Object.freeze({ status: "ok", stale: false, date: "2026-08-14", focus: Object.freeze([{ text: "old", done: false }]) }) }),
    intent,
    now: NOW
  });
  assert.equal(context.focus.freshness, "stale");
});

test("an unconfigured/error section requested alone yields no usable context (never fabricated)", () => {
  const intent = matchJarvisDailyIntent("Welche Termine habe ich heute?");
  const context = buildJarvisDailyContext({
    cockpitStatus: cockpitOk({ calendar: Object.freeze({ status: "unconfigured", stale: false, events: Object.freeze([]) }) }),
    intent,
    now: NOW
  });
  assert.equal(context, null);
});

test("an empty-but-reached section (no focus set today) is real content, not null", () => {
  const intent = matchJarvisDailyIntent("Was ist mein Fokus?");
  const context = buildJarvisDailyContext({
    cockpitStatus: cockpitOk({ dailyState: Object.freeze({ status: "ok", stale: false, date: "2026-08-15", focus: Object.freeze([]) }) }),
    intent,
    now: NOW
  });
  assert.ok(context);
  assert.equal(context.focus.freshness, "empty");
  assert.equal(context.focus.items.length, 0);
});
