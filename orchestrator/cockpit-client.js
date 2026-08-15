// Read-only client for Felix Cockpit's GET /api/cockpit-status. Everything
// this module is allowed to do: build one GET request from server-only
// configuration, verify transport shape (content type, size, JSON), and
// hand back the three sections Jarvis's daily context actually needs
// (dailyState, tasks, calendar) in a closed, defensively re-validated
// shape. It never writes, never triggers Quick Capture, never touches the
// training/github/news/aiRouter sections, and never forwards a caller-
// supplied context - the base URL and token come exclusively from the
// server's own environment (AI_ROUTER_COCKPIT_BASE_URL,
// AI_ROUTER_COCKPIT_READ_TOKEN), mirroring the same env-only trust boundary
// ollama-availability.js already uses for the Ollama base URL.
//
// Fail-closed by construction: any missing config, network error, timeout,
// wrong content type, oversized body, invalid JSON or unrecognised shape
// collapses to state "unavailable" (or "unconfigured" when nothing was
// even attempted) - never a thrown error, never a partial guess. The
// caller (jarvis-daily-context.js) is the one place that decides whether
// "unavailable" still leaves something answerable.

export const COCKPIT_BASE_URL_ENV_VAR = "AI_ROUTER_COCKPIT_BASE_URL";
export const COCKPIT_READ_TOKEN_ENV_VAR = "AI_ROUTER_COCKPIT_READ_TOKEN";
export const COCKPIT_STATUS_PATH = "/api/cockpit-status";
export const COCKPIT_STATUS_TIMEOUT_MS = 2_500;
export const COCKPIT_STATUS_MAX_BODY_BYTES = 131_072; // 128 KiB - generous for a 300-task list, still a hard cap.

const SECTION_STATUS_VALUES = new Set(["ok", "stale", "empty", "unconfigured", "error"]);
const FOCUS_ITEM_MAX_TEXT_CHARS = 200;
const TASK_MAX_TEXT_CHARS = 600;
const TASK_STATUS_VALUES = new Set(["open", "in-progress", "completed", "blocked"]);
const TASK_PRIORITY_VALUES = new Set(["", "high", "medium", "low"]);
const CALENDAR_MAX_TITLE_CHARS = 200;
const CALENDAR_MAX_LOCATION_CHARS = 200;

function trimmedEnvString(env, key) {
  const raw = env?.[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

// Re-validates one focus item from cockpit/daily-state.json's own shape
// (api/daily-state.js) rather than trusting it verbatim - a document
// boundary the server crossed over the network, not process-internal data.
function normalizeFocusItem(item) {
  if (!isPlainObject(item)) return null;
  const text = safeString(item.text, FOCUS_ITEM_MAX_TEXT_CHARS);
  if (!text || typeof item.done !== "boolean") return null;
  return Object.freeze({ text, done: item.done });
}

function normalizeDailyStateSection(section) {
  if (!isPlainObject(section) || !SECTION_STATUS_VALUES.has(section.status)) return null;
  const base = { status: section.status, stale: section.stale === true, updatedAt: safeString(section.updatedAt, 64) };
  if (section.status !== "ok" && section.status !== "stale") return Object.freeze({ ...base, date: null, focus: Object.freeze([]) });
  const state = section.data?.state;
  const date = typeof state?.date === "string" ? state.date : null;
  const focusRaw = Array.isArray(state?.focus) ? state.focus : [];
  const focus = focusRaw.map(normalizeFocusItem).filter(Boolean);
  if (!date) return null;
  return Object.freeze({ ...base, date, focus: Object.freeze(focus) });
}

function normalizeTaskItem(item) {
  if (!isPlainObject(item)) return null;
  const text = safeString(item.text, TASK_MAX_TEXT_CHARS);
  if (!text) return null;
  if (!TASK_STATUS_VALUES.has(item.status)) return null;
  if (!TASK_PRIORITY_VALUES.has(item.priority)) return null;
  const dueDate = typeof item.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate) ? item.dueDate : "";
  return Object.freeze({
    text,
    status: item.status,
    priority: item.priority,
    dueDate,
    project: safeString(item.project, 160) || "",
    blocked: item.blocked === true
  });
}

function normalizeTasksSection(section) {
  if (!isPlainObject(section) || !SECTION_STATUS_VALUES.has(section.status)) return null;
  const base = { status: section.status, stale: section.stale === true, updatedAt: safeString(section.updatedAt, 64) };
  if (section.status !== "ok" && section.status !== "stale") return Object.freeze({ ...base, tasks: Object.freeze([]) });
  const tasksRaw = Array.isArray(section.data?.state?.tasks) ? section.data.state.tasks : [];
  const tasks = tasksRaw.map(normalizeTaskItem).filter(Boolean);
  return Object.freeze({ ...base, tasks: Object.freeze(tasks) });
}

function normalizeCalendarEvent(event) {
  if (!isPlainObject(event)) return null;
  const title = safeString(event.title, CALENDAR_MAX_TITLE_CHARS);
  const start = safeString(event.start, 64);
  const end = safeString(event.end, 64);
  if (!title || !start || !end) return null;
  return Object.freeze({
    title,
    start,
    end,
    allDay: event.allDay === true,
    location: safeString(event.location, CALENDAR_MAX_LOCATION_CHARS) || null
  });
}

function normalizeCalendarSection(section) {
  if (!isPlainObject(section) || !SECTION_STATUS_VALUES.has(section.status)) return null;
  const base = { status: section.status, stale: section.stale === true, updatedAt: safeString(section.updatedAt, 64) };
  if (section.status !== "ok" && section.status !== "stale") return Object.freeze({ ...base, events: Object.freeze([]) });
  const eventsRaw = Array.isArray(section.data?.events) ? section.data.events : [];
  const events = eventsRaw.map(normalizeCalendarEvent).filter(Boolean);
  return Object.freeze({ ...base, events: Object.freeze(events) });
}

async function readBoundedJson(response, maxBodyBytes) {
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) return null;
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    response.body?.cancel?.().catch?.(() => {});
    return null;
  }
  let raw;
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  if (Buffer.byteLength(raw, "utf8") > maxBodyBytes) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const UNAVAILABLE_RESULT = Object.freeze({ state: "unavailable", generatedAt: null, dailyState: null, tasks: null, calendar: null });
const UNCONFIGURED_RESULT = Object.freeze({ state: "unconfigured", generatedAt: null, dailyState: null, tasks: null, calendar: null });

// Never throws. Callers that only need "is there anything usable" can read
// `state`; callers that render content read the three section fields, each
// independently null when cockpit-status.js itself reported nothing usable
// for that section (or when the section failed re-validation here).
export async function fetchCockpitStatus({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = COCKPIT_STATUS_TIMEOUT_MS,
  maxBodyBytes = COCKPIT_STATUS_MAX_BODY_BYTES
} = {}) {
  const baseUrl = trimmedEnvString(env, COCKPIT_BASE_URL_ENV_VAR);
  const token = trimmedEnvString(env, COCKPIT_READ_TOKEN_ENV_VAR);
  if (!baseUrl || !token) return UNCONFIGURED_RESULT;

  let url;
  try {
    url = new URL(COCKPIT_STATUS_PATH, baseUrl).toString();
  } catch {
    return UNCONFIGURED_RESULT;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json", authorization: `Bearer ${token}` }
      });
    } catch {
      return UNAVAILABLE_RESULT;
    }
    if (!response?.ok) {
      response?.body?.cancel?.().catch?.(() => {});
      return UNAVAILABLE_RESULT;
    }
    const payload = await readBoundedJson(response, maxBodyBytes);
    if (!isPlainObject(payload) || !isPlainObject(payload.services)) return UNAVAILABLE_RESULT;

    const generatedAt = safeString(payload.generatedAt, 64);
    const dailyState = normalizeDailyStateSection(payload.services.dailyState);
    const tasks = normalizeTasksSection(payload.services.tasks);
    const calendar = normalizeCalendarSection(payload.services.calendar);
    if (!dailyState && !tasks && !calendar) return UNAVAILABLE_RESULT;

    return Object.freeze({ state: "ok", generatedAt, dailyState, tasks, calendar });
  } finally {
    clearTimeout(timer);
  }
}

export const cockpitClientInternals = Object.freeze({
  normalizeDailyStateSection,
  normalizeTasksSection,
  normalizeCalendarSection,
  normalizeFocusItem,
  normalizeTaskItem,
  normalizeCalendarEvent
});
