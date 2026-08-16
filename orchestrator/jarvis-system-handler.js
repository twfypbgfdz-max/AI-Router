import { sendJson } from "./http-utils.js";
import { fetchCommandCenterStatus } from "./command-center-client.js";

// GET /api/jarvis/system - DEC-010 Phase 4B. Read-only, no token: same
// trust level as /api/jarvis/today and /api/jarvis/ready. Calls only
// fetchCommandCenterStatus() (orchestrator/command-center-client.js) - no
// own status logic, no freshness calculation, no combining of fields. The
// seven Status-Companion-Datenvertrag-v1 fields are passed through
// unchanged when available; otherwise `status` is null and `commandCenterState`
// says why (mirrors jarvis-today-handler.js's cockpitState field exactly).
export function createJarvisSystemHandler({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async function handleJarvisSystem(request, response) {
    const result = await fetchCommandCenterStatus({ env, fetchImpl });
    sendJson(response, 200, {
      schemaVersion: "1.0",
      commandCenterState: result.state,
      status: result.status
    });
  };
}

export const handleJarvisSystem = createJarvisSystemHandler();
