// R5 - Action Resolution + Approval Resume. The functional surface the spec
// asks for - approve(actionRequestId) / reject(actionRequestId) / an
// implicit resume() - collapsed into the smallest correct shape: both a
// human "approve" and "reject" decision are recorded via the pending store
// and then handed straight to action-service.js's own submit(), which
// already knows how to turn an approval into either an execution or a
// clean ACTION_APPROVAL_REJECTED denial. There is no separate resume() a
// caller can invoke independently of a decision - a pending request cannot
// become approved without a decision, so "approve" already *is* resume.
//
// This module owns none of the actual approval judgement - it only:
//   1. claims the pending record (default deny: unknown/expired/already-
//      decided ids are rejected before action-service is ever touched);
//   2. resubmits the original, already registry-validated actionId and
//      parameters (never anything read from the HTTP body except the
//      decision itself) to action-service.js's normal pipeline, so a
//      tampered/mismatched parameter set is revalidated against the
//      registry exactly as any other submission would be;
//   3. records the terminal outcome so the request can never run twice.
//
// Approval itself must come from a trusted, explicit source - see R5 spec
// §11: this module builds only the technical foundation, not an
// authenticated approval UI. Callers of decideActionApproval() are
// responsible for having already established that decidedBy is who they
// claim to be (today: the local, same-origin trust boundary server.js's
// isTrustedMutation() already enforces for every other mutating endpoint).
import { RouterError } from "../contracts.js";
import { actionService as defaultActionService } from "./action-service.js";
import { actionPendingStore as defaultPendingStore } from "./action-pending-store.js";
import { logger as defaultLogger } from "../logger.js";

const CLAIM_ERROR_TO_ROUTER_ERROR = Object.freeze({
  ACTION_PENDING_NOT_FOUND: () => new RouterError("ACTION_PENDING_NOT_FOUND", "No pending action request with this id."),
  ACTION_PENDING_EXPIRED: () => new RouterError("ACTION_PENDING_EXPIRED", "This pending action request has expired and can no longer be decided."),
  ACTION_PENDING_ALREADY_DECIDED: () => new RouterError("ACTION_PENDING_ALREADY_DECIDED", "This pending action request has already been decided."),
  ACTION_REQUEST_INVALID: () => new RouterError("ACTION_REQUEST_INVALID", "decidedBy is required.")
});

export function createActionApprovalService({
  actionService = defaultActionService,
  pendingStore = defaultPendingStore,
  logger = defaultLogger
} = {}) {
  async function auditPendingEvent(event, requestId, extra = {}) {
    try {
      await logger.log({ level: "info", event, requestId, safeMetadata: extra });
    } catch {
      // Never let an audit failure change the outcome of a decision.
    }
  }

  return {
    // decision: "approve" | "reject". decidedBy/note: same shape and same
    // bounds as action-policy.js's normalizeApproval - this module reuses
    // that normalization indirectly by handing the raw decision through to
    // action-service.js's own submit(), which is the single place that
    // already enforces it.
    async decide(requestId, { decision, decidedBy, note = "" } = {}) {
      if (decision !== "approve" && decision !== "reject") {
        throw new RouterError("ACTION_REQUEST_INVALID", "decision must be \"approve\" or \"reject\".");
      }

      let claimed;
      try {
        claimed = await pendingStore.claimForDecision(requestId, { decision, decidedBy, note });
      } catch (error) {
        const build = CLAIM_ERROR_TO_ROUTER_ERROR[error.message];
        if (build) {
          await auditPendingEvent(
            error.message === "ACTION_PENDING_EXPIRED" ? "action_pending_expired" : "action_pending_replay_blocked",
            requestId,
            { reason: error.message }
          );
          throw build();
        }
        throw error;
      }

      // Same envelope shape action-service.js's own submit() already
      // accepts - requestId is passed through so the resumed request keeps
      // its original audit trail id instead of minting a new one.
      const result = await actionService.submit({
        requestId: claimed.requestId,
        actionId: claimed.actionId,
        parameters: claimed.parameters,
        origin: claimed.origin,
        approval: { decision, decidedBy: claimed.decidedBy, note: claimed.note || "" }
      });

      if (decision === "approve") {
        const terminal = result.status === "completed" ? "completed" : "failed";
        await pendingStore.finalizeResume(requestId, terminal);
        await auditPendingEvent("action_pending_resumed", requestId, { outcome: terminal });
      }
      // A "reject" decision is already terminal in the pending store
      // (claimForDecision wrote "rejected" before action-service ever ran)
      // - nothing further to finalize.

      return result;
    },

    async get(requestId) {
      return pendingStore.get(requestId);
    }
  };
}

export const actionApprovalService = createActionApprovalService();
