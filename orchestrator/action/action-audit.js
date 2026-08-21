// R4 - Action Foundation. Audit trail for the action layer.
//
// This is deliberately a thin adapter over the orchestrator's existing
// logger (orchestrator/logger.js) rather than a second logging stack: same
// JSONL file, same rotation, same secret masking, same KNOWN_LOG_EVENTS
// vocabulary (the eight action_request_* events were added there, not
// invented here). The only thing this module owns is the mapping from a
// lifecycle status to an event name, and the rule for what of a request is
// safe to write down.
//
// What is written: timestamp (added by the logger), request id, action id,
// status, origin, risk, approval status and decider, and the safe error
// code. What is deliberately NOT written: any free text from the user, the
// original question, and any executor result payload. Parameters are
// included because the registry only permits closed enum values, so a
// parameter cannot carry arbitrary content by construction - it is still
// passed through the logger's own masking on the way out.
import { logger as defaultLogger } from "../logger.js";

const STATUS_EVENTS = Object.freeze({
  created: "action_request_created",
  validated: "action_request_validated",
  approval_required: "action_request_approval_required",
  approved: "action_request_approved",
  rejected: "action_request_rejected",
  executing: "action_request_executing",
  completed: "action_request_completed",
  failed: "action_request_failed"
});

export const ACTION_AUDIT_EVENTS = Object.freeze(Object.values(STATUS_EVENTS));

export function auditEventForStatus(status) {
  return STATUS_EVENTS[status] || null;
}

function safeParameters(parameters) {
  const keys = parameters && typeof parameters === "object" ? Object.keys(parameters).sort() : [];
  if (keys.length === 0) return "";
  // key=value pairs of already-validated enum values only - never a nested
  // object, never a raw caller payload.
  return keys.map((key) => `${key}=${parameters[key]}`).join(",").slice(0, 160);
}

export function createActionAudit({ logger = defaultLogger } = {}) {
  return {
    // Never throws and never rejects: an audit write failing must not turn
    // an otherwise correct denial into a 500, and must never be a way to
    // make a request succeed. Callers await it, but its failure is
    // swallowed on purpose - the decision it describes has already been
    // made at this point and does not depend on the log.
    async record(request) {
      const event = auditEventForStatus(request?.status);
      if (!event) return false;
      const parameters = safeParameters(request.parameters);
      try {
        await logger.log({
          level: request.status === "failed" ? "error" : "info",
          event,
          requestId: request.requestId,
          status: request.status,
          safeMetadata: {
            actionId: request.actionId || "unresolved",
            origin: request.origin,
            ...(request.risk ? { risk: request.risk } : {}),
            approvalStatus: request.approval?.status || "none",
            ...(request.approval?.decidedBy ? { decidedBy: request.approval.decidedBy } : {}),
            ...(parameters ? { parameters } : {}),
            ...(request.error ? { errorCode: request.error.code } : {})
          }
        });
        return true;
      } catch {
        return false;
      }
    }
  };
}

export const actionAudit = createActionAudit();
