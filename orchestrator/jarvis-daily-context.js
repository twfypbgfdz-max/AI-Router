// Turns one already-fetched cockpit-client.js result plus one already
// matched jarvis-daily-intent.js intent into the closed operational-context
// object the knowledge path renders into the prompt (see
// knowledge-answer-prompt.js's buildOperationalContextBlock). This module
// never calls the network itself and never re-matches intent - both are the
// caller's job, kept separate so each piece stays independently testable.
//
// Budgets are enforced here, once, so no caller can accidentally hand the
// full task list to the prompt: at most 3 focus items (already cockpit's
// own cap), at most 8 tasks, at most 5 calendar events - all deterministic
// server-side ranking, never the model's choice.
//
// Returns null whenever nothing requested actually came back usable
// (cockpit unreachable, or every requested section unconfigured/error) -
// that is the deliberate signal to knowledge-service.js that no fabricated
// "today" should be offered, distinct from "cockpit reached and genuinely
// has nothing" (e.g. no focus set today), which is real, usable content.

const MAX_FOCUS_ITEMS = 3;
const MAX_TASKS = 8;
const MAX_CALENDAR_EVENTS = 5;

function todayKeyOf(now) {
  return now.toISOString().slice(0, 10);
}

function buildFocusBlock(dailyState, todayIso) {
  if (!dailyState) return Object.freeze({ freshness: "unavailable", items: Object.freeze([]) });
  if (dailyState.status === "unconfigured") return Object.freeze({ freshness: "unconfigured", items: Object.freeze([]) });
  if (dailyState.status === "error") return Object.freeze({ freshness: "error", items: Object.freeze([]) });
  const isDateStale = dailyState.date !== todayIso;
  const items = Object.freeze(dailyState.focus.slice(0, MAX_FOCUS_ITEMS).map((item) => Object.freeze({ text: item.text, done: item.done })));
  const freshness = dailyState.stale || isDateStale ? "stale" : items.length === 0 ? "empty" : "fresh";
  return Object.freeze({ freshness, items, date: dailyState.date });
}

function taskRank(task, todayIso, { emphasizeOverdue }) {
  const overdue = task.dueDate !== "" && task.dueDate < todayIso;
  const dueToday = task.dueDate === todayIso;
  if (task.blocked) return 0;
  if (overdue) return emphasizeOverdue ? 0 : 1;
  if (dueToday) return 2;
  if (task.status === "in-progress") return 3;
  return 4;
}

function buildTasksBlock(tasksSection, { taskView, emphasizeOverdue }, todayIso) {
  if (!tasksSection) return Object.freeze({ freshness: "unavailable", items: Object.freeze([]), view: taskView });
  if (tasksSection.status === "unconfigured") return Object.freeze({ freshness: "unconfigured", items: Object.freeze([]), view: taskView });
  if (tasksSection.status === "error") return Object.freeze({ freshness: "error", items: Object.freeze([]), view: taskView });

  const wantDone = taskView === "done";
  const pool = tasksSection.tasks.filter((task) => (wantDone ? task.status === "completed" : task.status !== "completed"));
  const ranked = [...pool].sort((a, b) => taskRank(a, todayIso, { emphasizeOverdue }) - taskRank(b, todayIso, { emphasizeOverdue }));
  const items = Object.freeze(ranked.slice(0, MAX_TASKS).map((task) => Object.freeze({
    text: task.text,
    status: task.status,
    priority: task.priority || null,
    dueDate: task.dueDate || null,
    overdue: task.dueDate !== "" && task.dueDate < todayIso,
    blocked: task.blocked
  })));
  const freshness = tasksSection.stale ? "stale" : items.length === 0 ? "empty" : "fresh";
  return Object.freeze({ freshness, items, view: taskView, matchingCount: pool.length });
}

function buildCalendarBlock(calendarSection, todayIso) {
  if (!calendarSection) return Object.freeze({ freshness: "unavailable", items: Object.freeze([]) });
  if (calendarSection.status === "unconfigured") return Object.freeze({ freshness: "unconfigured", items: Object.freeze([]) });
  if (calendarSection.status === "error") return Object.freeze({ freshness: "error", items: Object.freeze([]) });

  const todaysEvents = calendarSection.events
    .filter((event) => event.start.slice(0, 10) === todayIso)
    .sort((a, b) => a.start.localeCompare(b.start));
  const items = Object.freeze(todaysEvents.slice(0, MAX_CALENDAR_EVENTS).map((event) => Object.freeze({
    title: event.title, start: event.start, end: event.end, allDay: event.allDay, location: event.location
  })));
  const freshness = calendarSection.stale ? "stale" : items.length === 0 ? "empty" : "fresh";
  return Object.freeze({ freshness, items });
}

const USABLE_FRESHNESS = new Set(["fresh", "stale", "empty"]);

// intent: the closed object matchJarvisDailyIntent() returns (never null -
// callers only invoke this after a positive match). cockpitStatus: the
// closed object fetchCockpitStatus() returns.
export function buildJarvisDailyContext({ cockpitStatus, intent, now = () => new Date() } = {}) {
  if (!intent || !cockpitStatus || cockpitStatus.state !== "ok") return null;

  const todayIso = todayKeyOf(now());
  const focus = intent.needsDailyState ? buildFocusBlock(cockpitStatus.dailyState, todayIso) : null;
  const tasks = intent.needsTasks ? buildTasksBlock(cockpitStatus.tasks, intent, todayIso) : null;
  const calendar = intent.needsCalendar ? buildCalendarBlock(cockpitStatus.calendar, todayIso) : null;

  const requestedBlocks = [focus, tasks, calendar].filter(Boolean);
  const anyUsable = requestedBlocks.some((block) => USABLE_FRESHNESS.has(block.freshness));
  if (!anyUsable) return null;

  return Object.freeze({ today: todayIso, focus, tasks, calendar });
}

export const jarvisDailyContextInternals = Object.freeze({ buildFocusBlock, buildTasksBlock, buildCalendarBlock });
