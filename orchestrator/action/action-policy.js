// R4 - Action Foundation. The permission layer: given a registry definition
// and (optionally) an explicit human decision, decide whether this request
// may proceed to an executor at all.
//
// One direction only. The policy may raise an action's approval requirement
// but never lower it: a definition that says requiresApproval: true stays
// approval-gated no matter what, and there is no input - not a parameter,
// not an origin, not a caller flag - that can turn an approval-required
// action into a free one. That is what "kein Permission Escalation" means
// here, and it is why this function takes no caller-supplied policy object.
import { RouterError } from "../contracts.js";

// Approval is required for everything except explicitly LOW-risk actions
// that their own definition also marks as approval-free. MEDIUM is a
// visible state change and HIGH is destructive/external, so both are gated
// unconditionally - "im Zweifel Approval verlangen", expressed as code
// rather than as a convention someone has to remember.
export function requiresApproval(definition) {
  if (definition.requiresApproval === true) return true;
  return definition.risk !== "low";
}

const DECISIONS = Object.freeze(["approve", "reject"]);
const MAX_NOTE_LENGTH = 200;
const MAX_ACTOR_LENGTH = 64;

// An approval is a *record of a decision a human already made*, handed in by
// the caller. This layer never produces one, never infers one from context
// and never treats "no approval supplied" as approval - a missing or
// malformed decision leaves the request unapproved.
export function normalizeApproval(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new RouterError("ACTION_REQUEST_INVALID", "approval must be an object.");
  if (!DECISIONS.includes(input.decision)) throw new RouterError("ACTION_REQUEST_INVALID", "approval.decision must be \"approve\" or \"reject\".");
  const decidedBy = typeof input.decidedBy === "string" ? input.decidedBy.replace(/[^\w.@-]/g, "").slice(0, MAX_ACTOR_LENGTH) : "";
  if (!decidedBy) throw new RouterError("ACTION_REQUEST_INVALID", "approval.decidedBy is required.");
  const note = typeof input.note === "string" ? input.note.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_LENGTH) : "";
  return Object.freeze({ decision: input.decision, decidedBy, note, decidedAt: new Date().toISOString() });
}

// The single decision point the service consults. Returns one of three
// outcomes and nothing else:
//   "allowed"           - may proceed to the executor
//   "approval_required" - valid, but no decision has been supplied
//   "rejected"          - a human explicitly said no
export function evaluateActionPolicy(definition, approval) {
  const needsApproval = requiresApproval(definition);
  if (approval?.decision === "reject") {
    return Object.freeze({ outcome: "rejected", needsApproval, reason: "Die Freigabe wurde ausdruecklich verweigert." });
  }
  if (!needsApproval) {
    // An approval supplied for an action that does not need one is simply
    // redundant, never a reason to reject - but it is still recorded.
    return Object.freeze({ outcome: "allowed", needsApproval, reason: "Risikoklasse low und laut Registry ohne Freigabepflicht." });
  }
  if (approval?.decision === "approve") {
    return Object.freeze({ outcome: "allowed", needsApproval, reason: "Ausdrueckliche Freigabe liegt vor." });
  }
  return Object.freeze({ outcome: "approval_required", needsApproval, reason: `Risikoklasse ${definition.risk}: Freigabe erforderlich, es liegt keine vor.` });
}
