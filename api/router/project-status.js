import { handleProjectStatusRequest } from "../../orchestrator/text-response-handler.js";

export const config = { maxDuration: 25 };

// Same read-only text-response pipeline as /api/router/respond (auth, rate
// limiting, egress policy, cost guard, provider adapter), with the intent
// pinned server-side to "project_status_report" so the caller cannot choose
// a different report shape. The caller supplies the actual project status
// facts via `context`; this endpoint only summarizes what it is given as one
// structured JSON object (see PROJECT_STATUS_REPORT_INSTRUCTIONS in
// text-response-prompt.js).
export default function projectStatus(request, response) {
  return handleProjectStatusRequest(request, response);
}
