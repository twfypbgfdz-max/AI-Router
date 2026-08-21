// R4 - Action Foundation (Felix Core Foundation v2). The vocabulary of the
// action layer: risk classes, the request lifecycle and the request shape
// itself. Deliberately data-only - no registry, no policy, no execution
// lives here, so that every other action module can import these constants
// without importing behaviour.
//
// Boundary note (important, read before extending): this is NOT the same
// thing as orchestrator/action-registry.js. That file is the *Router API*
// allowlist behind GET /api/router/actions (router.status, tasks.list, ...);
// it is simulation-only by contract, has no parameters, no executors and no
// approval decisions, and its public shape is pinned by
// test/router-foundation.test.js. R4 does not touch, extend or re-export it.
// This directory is the Jarvis action layer. Merging the two is an explicit
// R5+ decision, not a side effect of R4 (see docs/action-foundation-r4.md).

// Three levels, exactly as the R4 spec defines them. The ordering matters:
// policy escalates, never de-escalates, and compares by index.
export const ACTION_RISK_LEVELS = Object.freeze(["low", "medium", "high"]);

// LOW    - passive or very narrowly bounded, no visible state change.
// MEDIUM - visible state change on this machine.
// HIGH   - destructive, external or otherwise sensitive.
export const ACTION_RISK_DESCRIPTIONS = Object.freeze({
  low: "Passiv oder sehr eng begrenzt, keine sichtbare Zustandsaenderung.",
  medium: "Sichtbare Zustandsaenderung.",
  high: "Destruktiv, extern wirksam oder sensibel."
});

// The minimal lifecycle that the R4 spec's list reduces to once the states
// that cannot actually occur in this system are removed. "validated" is kept
// separate from "approval_required" on purpose: a request can be structurally
// valid and still never be allowed to run, and the audit trail must be able
// to tell those two apart.
export const ACTION_STATUSES = Object.freeze([
  "created",
  "validated",
  "approval_required",
  "approved",
  "rejected",
  "executing",
  "completed",
  "failed"
]);

export const ACTION_TERMINAL_STATUSES = Object.freeze(["rejected", "completed", "failed"]);

// Fail-closed by construction: a transition that is not listed here cannot
// happen, and there is no path from any state back to "created". In
// particular there is no edge from "approval_required" or "rejected" to
// "executing" - approval can only ever be granted by a caller supplying an
// explicit decision, which produces "approved" first.
const ALLOWED_TRANSITIONS = Object.freeze({
  created: Object.freeze(["validated", "rejected", "failed"]),
  validated: Object.freeze(["approval_required", "approved", "executing", "rejected", "failed"]),
  approval_required: Object.freeze(["approved", "rejected"]),
  approved: Object.freeze(["executing", "rejected", "failed"]),
  rejected: Object.freeze([]),
  executing: Object.freeze(["completed", "failed"]),
  completed: Object.freeze([]),
  failed: Object.freeze([])
});

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

// Closed error-code set for the action layer. These are additionally
// registered in the central orchestrator/policy.js ERROR_CODES list so that
// the existing diagnostics/cockpit surfaces keep recognising them - the
// action layer does not open a second, parallel error vocabulary.
export const ACTION_ERROR_CODES = Object.freeze([
  "ACTION_NOT_REGISTERED",
  "ACTION_PARAMETERS_INVALID",
  "ACTION_APPROVAL_REQUIRED",
  "ACTION_APPROVAL_REJECTED",
  "ACTION_EXECUTOR_UNAVAILABLE",
  "ACTION_EXECUTION_FAILED",
  "ACTION_REQUEST_INVALID",
  // R6 - First Safe Executor (app.open). Structured launch-failure codes an
  // executor may throw with `.code` set; action-service.js's executor catch
  // preserves them instead of collapsing everything to
  // ACTION_EXECUTION_FAILED, see app-launcher.js.
  "APP_NOT_ALLOWED",
  "APP_NOT_INSTALLED",
  "APP_LAUNCH_FAILED"
]);

// Only these namespaces exist. A definition outside them is a registry
// error, not a runtime rejection - see action-registry.js. file.*,
// calendar.* and email.* are listed because the spec names them as the
// intended namespaces, NOT because R4 ships any action in them.
export const ACTION_NAMESPACES = Object.freeze(["system", "app", "file", "calendar", "email", "jarvis"]);

// Where a request came from. Closed set: an origin is metadata that ends up
// in the audit log, so it must never be free-form caller text.
export const ACTION_ORIGINS = Object.freeze(["jarvis-ask", "api", "internal", "test"]);

const ACTION_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

export function isValidActionId(value) {
  return typeof value === "string"
    && value.length <= 64
    && ACTION_ID_PATTERN.test(value)
    && ACTION_NAMESPACES.includes(value.split(".")[0]);
}
