// R4 - Action Foundation. The one path an action request may take, and the
// only place that is allowed to call an executor.
//
//   submit() -> validate envelope -> registry (default deny)
//            -> parameter validation -> policy / approval -> executor -> audit
//
// The executor boundary, stated precisely, because it is the whole point of
// R4: an executor is a function stored in a registry definition in this
// repository. It is called with exactly two arguments - the frozen,
// already-validated parameter object, and a small fixed context - and it is
// reached only after the registry resolved the action and the policy
// allowed it. There is no run(command), no exec(shellString), no way for a
// caller (and therefore no way for a model) to supply, name or influence the
// code that runs. Free text never reaches this module at all: submit() takes
// a structured actionId plus enum parameters, never a question or a sentence.
import crypto from "node:crypto";
import { RouterError } from "../contracts.js";
import { sanitizeText } from "../jsonl.js";
import { actionRegistry, validateActionParameters } from "./action-registry.js";
import { evaluateActionPolicy, normalizeApproval } from "./action-policy.js";
import { actionAudit } from "./action-audit.js";
import { ACTION_ERROR_CODES, ACTION_ORIGINS, canTransition } from "./action-types.js";

const ERROR_CODE_SET = new Set(ACTION_ERROR_CODES);

function newRequestId() {
  return `act_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function publicView(request) {
  return Object.freeze({
    requestId: request.requestId,
    actionId: request.actionId,
    origin: request.origin,
    status: request.status,
    risk: request.risk,
    parameters: request.parameters,
    approval: Object.freeze({ ...request.approval }),
    executed: request.status === "completed",
    result: request.result,
    error: request.error ? Object.freeze({ ...request.error }) : null,
    history: Object.freeze([...request.history])
  });
}

export function createActionService({ registry = actionRegistry, audit = actionAudit } = {}) {
  // Advances the lifecycle and writes exactly one audit entry per
  // transition. An illegal transition is a bug in this file, not a caller
  // error, so it throws rather than degrading quietly.
  async function transition(request, status, patch = {}) {
    if (!canTransition(request.status, status)) throw new Error(`Illegal action status transition ${request.status} -> ${status}.`);
    Object.assign(request, patch, { status });
    request.history.push({ status, at: new Date().toISOString() });
    await audit.record(request);
    return request;
  }

  async function fail(request, code, message) {
    const error = { code: ERROR_CODE_SET.has(code) ? code : "ACTION_EXECUTION_FAILED", message };
    // "rejected" is the terminal state for a request that was never allowed
    // to run; "failed" is for one that was allowed and then could not be
    // completed. Keeping them apart is what makes the audit trail able to
    // answer "was this denied or did it break?".
    const status = canTransition(request.status, "rejected") && code !== "ACTION_EXECUTION_FAILED" && code !== "ACTION_EXECUTOR_UNAVAILABLE"
      ? "rejected"
      : "failed";
    await transition(request, status, { error });
    return publicView(request);
  }

  return {
    registry,

    // The single entry point. Always resolves - a denied, unapproved or
    // broken request comes back as a terminal request object, never as a
    // thrown error, so that every outcome has a request id and an audit
    // entry. Only a malformed envelope (not an object) is rejected outright.
    async submit(input = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new RouterError("ACTION_REQUEST_INVALID", "Action request must be an object.");
      }
      const origin = ACTION_ORIGINS.includes(input.origin) ? input.origin : null;
      if (!origin) throw new RouterError("ACTION_REQUEST_INVALID", "origin is not an allowed value.");

      const request = {
        requestId: typeof input.requestId === "string" && /^act_[0-9]+_[0-9a-f]{8}$/.test(input.requestId) ? input.requestId : newRequestId(),
        actionId: typeof input.actionId === "string" ? input.actionId.slice(0, 64) : null,
        origin,
        status: "created",
        risk: null,
        parameters: null,
        approval: { required: false, status: "none", decidedBy: null, note: "", decidedAt: null },
        result: null,
        error: null,
        history: []
      };
      request.history.push({ status: "created", at: new Date().toISOString() });
      await audit.record(request);

      // An explicit decision is normalized before anything else touches it,
      // so a malformed approval can never be mistaken for a granted one.
      let approval = null;
      try {
        approval = normalizeApproval(input.approval);
      } catch (error) {
        return fail(request, "ACTION_REQUEST_INVALID", error.message);
      }

      // --- Default deny -----------------------------------------------------
      let definition;
      try {
        definition = registry.resolve(request.actionId);
      } catch (error) {
        return fail(request, error.code === "ACTION_NOT_REGISTERED" ? "ACTION_NOT_REGISTERED" : "ACTION_REQUEST_INVALID", error.message);
      }
      request.risk = definition.risk;

      // --- Strict parameter validation --------------------------------------
      let parameters;
      try {
        parameters = validateActionParameters(definition, input.parameters);
      } catch (error) {
        return fail(request, "ACTION_PARAMETERS_INVALID", error.message);
      }
      await transition(request, "validated", { parameters });

      // --- Policy / approval ------------------------------------------------
      const decision = evaluateActionPolicy(definition, approval);
      request.approval.required = decision.needsApproval;
      if (approval) {
        request.approval.status = approval.decision === "approve" ? "approved" : "rejected";
        request.approval.decidedBy = approval.decidedBy;
        request.approval.note = approval.note;
        request.approval.decidedAt = approval.decidedAt;
      }

      if (decision.outcome === "rejected") {
        return fail(request, "ACTION_APPROVAL_REJECTED", decision.reason);
      }
      if (decision.outcome === "approval_required") {
        request.approval.status = "pending";
        await transition(request, "approval_required", { error: { code: "ACTION_APPROVAL_REQUIRED", message: decision.reason } });
        return publicView(request);
      }
      if (decision.needsApproval) await transition(request, "approved");

      // --- Executor boundary ------------------------------------------------
      if (typeof definition.executor !== "function") {
        await transition(request, "executing");
        return fail(request, "ACTION_EXECUTOR_UNAVAILABLE", "Fuer diese Action ist kein Executor registriert; sie wurde nicht ausgefuehrt.");
      }
      await transition(request, "executing");
      try {
        // Exactly the validated parameters, plus a fixed context. Nothing
        // from the raw input object is forwarded.
        const result = await definition.executor(parameters, { registry, requestId: request.requestId, actionId: definition.id });
        await transition(request, "completed", { result: result === undefined ? null : result });
        return publicView(request);
      } catch (error) {
        // An executor's own error text is never trusted verbatim in a
        // response: it is masked and bounded like every other adapter
        // output in this repository. Its `.code`, if set, IS trusted when
        // (and only when) it is one of the closed ACTION_ERROR_CODES - that
        // is a structured signal from code in this repository (e.g.
        // app-launcher.js), not caller-controlled text, so preserving it
        // gives a caller APP_NOT_INSTALLED instead of a generic
        // ACTION_EXECUTION_FAILED without weakening the masking rule above.
        const code = ERROR_CODE_SET.has(error?.code) ? error.code : "ACTION_EXECUTION_FAILED";
        return fail(request, code, sanitizeText(error?.message, 160) || "Die Action konnte nicht abgeschlossen werden.");
      }
    }
  };
}

export const actionService = createActionService();
