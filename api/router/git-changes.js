import { handleGitChangeRequest } from "../../orchestrator/text-response-handler.js";

export const config = { maxDuration: 25 };

// Same read-only text-response pipeline as /api/router/respond, with the
// intent pinned server-side to "git_change_report" so the caller cannot
// choose a different report shape. The caller supplies the actual `git log`/
// `git diff` text via `context`; this endpoint only explains what it is given
// as one structured JSON object (see GIT_CHANGE_REPORT_INSTRUCTIONS in
// text-response-prompt.js). It never runs Git itself - it has no shell or
// file-system access.
export default function gitChanges(request, response) {
  return handleGitChangeRequest(request, response);
}
