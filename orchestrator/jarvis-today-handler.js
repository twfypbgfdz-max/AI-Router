import { sendJson } from "./http-utils.js";
import { fetchCockpitStatus } from "./cockpit-client.js";
import { FULL_DAY_INTENT } from "./jarvis-daily-intent.js";
import { buildJarvisDailyContext } from "./jarvis-daily-context.js";

// GET /api/jarvis/today - DEC-010 Phase 4A. The proactive counterpart to the
// reactive operational-context path already used inside /api/jarvis/ask
// (DEC-007): same two functions, same normalization, same budgets
// (MAX_FOCUS_ITEMS/MAX_TASKS/MAX_CALENDAR_EVENTS in jarvis-daily-context.js),
// same fail-closed contract - only the intent is fixed (FULL_DAY_INTENT)
// instead of derived from a question. No new data source, no own task/
// calendar logic, no write path. Read-only, no token: same trust level as
// /api/jarvis/ready and /api/health (see server.js).
//
// cockpitState is exposed alongside context so the page can show an honest
// reason ("nicht konfiguriert" vs. "nicht erreichbar") without this handler
// inventing any new interpretation - it is already a field on
// fetchCockpitStatus()'s own closed result shape.
export function createJarvisTodayHandler({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async function handleJarvisToday(request, response) {
    const cockpitStatus = await fetchCockpitStatus({ env, fetchImpl });
    const context = buildJarvisDailyContext({ cockpitStatus, intent: FULL_DAY_INTENT });
    sendJson(response, 200, {
      schemaVersion: "1.0",
      cockpitState: cockpitStatus.state,
      context
    });
  };
}

export const handleJarvisToday = createJarvisTodayHandler();
