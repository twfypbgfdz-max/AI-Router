import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createActionRegistry, actionRegistry, validateActionParameters } from "../orchestrator/action/action-registry.js";
import { createActionService } from "../orchestrator/action/action-service.js";
import { createActionAudit, ACTION_AUDIT_EVENTS } from "../orchestrator/action/action-audit.js";
import { evaluateActionPolicy, requiresApproval, normalizeApproval } from "../orchestrator/action/action-policy.js";
import { buildActionRequestFromIntent } from "../orchestrator/action/action-intent-bridge.js";
import { ACTION_NAMESPACES, ACTION_STATUSES, canTransition, isValidActionId } from "../orchestrator/action/action-types.js";
import { KNOWN_LOG_EVENTS } from "../orchestrator/logger.js";
import { ERROR_CODES } from "../orchestrator/policy.js";
import { createJarvisConsoleHandler } from "../orchestrator/jarvis-console-proxy.js";
import { KNOWLEDGE_TOKEN_ENV_VAR } from "../orchestrator/knowledge-config.js";

// --- helpers ---------------------------------------------------------------

function recordingAudit() {
  const entries = [];
  return { entries, audit: createActionAudit({ logger: { log: async (entry) => { entries.push(entry); } } }) };
}

// A fixture registry rather than the default one, so the pipeline's rules can
// be tested independently of which two actions R4 happens to ship.
function fixtureRegistry({ executor = () => ({ ok: true }), seen = null } = {}) {
  return createActionRegistry([
    {
      id: "jarvis.test.safe",
      description: "Low risk, no approval, executable.",
      risk: "low",
      requiresApproval: false,
      parameters: { mode: { type: "enum", required: false, values: ["a", "b"] } },
      executor: (parameters, context) => {
        if (seen) seen.push({ parameters, context });
        return executor(parameters, context);
      }
    },
    {
      id: "app.test.gated",
      description: "Medium risk, approval required, executable.",
      risk: "medium",
      requiresApproval: true,
      parameters: { target: { type: "enum", required: true, values: ["spotify"] } },
      executor: (parameters) => {
        if (seen) seen.push({ parameters });
        return { opened: parameters.target };
      }
    },
    {
      id: "file.test.declared",
      description: "Declared but intentionally without an executor.",
      risk: "high",
      requiresApproval: true,
      parameters: {},
      executor: null
    }
  ]);
}

const APPROVAL = { decision: "approve", decidedBy: "felix" };

function statuses(result) {
  return result.history.map((entry) => entry.status);
}

// --- 1. a known action is accepted -----------------------------------------

test("a known, low-risk action is validated and executed", async () => {
  const seen = [];
  const service = createActionService({ registry: fixtureRegistry({ seen }), audit: recordingAudit().audit });
  const result = await service.submit({ actionId: "jarvis.test.safe", parameters: { mode: "a" }, origin: "test" });

  assert.equal(result.status, "completed");
  assert.equal(result.executed, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.result, { ok: true });
  assert.deepEqual(statuses(result), ["created", "validated", "executing", "completed"]);
  assert.match(result.requestId, /^act_\d+_[0-9a-f]{8}$/);
});

test("the shipped default registry exposes only auditable, namespaced actions", () => {
  const described = actionRegistry.describe();
  assert.ok(described.length > 0);
  for (const action of described) {
    assert.ok(isValidActionId(action.id), `${action.id} is not a valid action id`);
    assert.ok(ACTION_NAMESPACES.includes(action.id.split(".")[0]));
    assert.ok(["low", "medium", "high"].includes(action.risk));
    assert.equal(typeof action.requiresApproval, "boolean");
    // Every parameter of every shipped action is a closed enum - no shipped
    // action can take free-form caller text.
    for (const spec of Object.values(action.parameters)) assert.equal(spec.type, "enum");
  }
  // The registry never hands an executor function out of its own boundary.
  assert.ok(described.every((action) => !Object.hasOwn(action, "executor")));
});

// --- 2. an unknown action is rejected (default deny) ------------------------

test("an unregistered action is rejected and never executed", async () => {
  const service = createActionService({ registry: fixtureRegistry(), audit: recordingAudit().audit });
  const result = await service.submit({ actionId: "email.send", parameters: { to: "max" }, origin: "api" });

  assert.equal(result.status, "rejected");
  assert.equal(result.executed, false);
  assert.equal(result.error.code, "ACTION_NOT_REGISTERED");
  assert.equal(result.result, null);
});

test("a missing or non-string action id is rejected, never guessed", async () => {
  const service = createActionService({ registry: fixtureRegistry(), audit: recordingAudit().audit });
  for (const actionId of [undefined, null, 42, {}, ""]) {
    const result = await service.submit({ actionId, origin: "api" });
    assert.equal(result.status, "rejected");
    assert.equal(result.error.code, "ACTION_NOT_REGISTERED");
  }
});

test("the registry has no dynamic registration path and no wildcard", () => {
  const registry = fixtureRegistry();
  assert.equal(registry.has("jarvis.test.*"), false);
  assert.equal(registry.has("*"), false);
  assert.equal(typeof registry.register, "undefined");
  assert.equal(typeof registry.add, "undefined");
  assert.throws(() => registry.resolve("jarvis.test.unknown"), { code: "ACTION_NOT_REGISTERED" });
});

// --- 3. invalid parameters are rejected ------------------------------------

test("a missing required parameter is rejected before any execution", async () => {
  const seen = [];
  const service = createActionService({ registry: fixtureRegistry({ seen }), audit: recordingAudit().audit });
  const result = await service.submit({ actionId: "app.test.gated", parameters: {}, origin: "api", approval: APPROVAL });

  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "ACTION_PARAMETERS_INVALID");
  assert.equal(seen.length, 0, "the executor must never see an invalid request");
});

test("an out-of-enum value, an unknown parameter and a non-object payload are all rejected", async () => {
  const seen = [];
  const service = createActionService({ registry: fixtureRegistry({ seen }), audit: recordingAudit().audit });
  const cases = [
    { actionId: "app.test.gated", parameters: { target: "notepad" } },
    { actionId: "app.test.gated", parameters: { target: "spotify", extra: "x" } },
    { actionId: "app.test.gated", parameters: "target=spotify" },
    { actionId: "app.test.gated", parameters: ["spotify"] },
    { actionId: "app.test.gated", parameters: { target: 1 } }
  ];
  for (const payload of cases) {
    const result = await service.submit({ ...payload, origin: "api", approval: APPROVAL });
    assert.equal(result.status, "rejected", JSON.stringify(payload));
    assert.equal(result.error.code, "ACTION_PARAMETERS_INVALID", JSON.stringify(payload));
  }
  assert.equal(seen.length, 0);
});

test("parameter validation is strict in both directions", () => {
  const definition = fixtureRegistry().resolve("app.test.gated");
  assert.deepEqual(validateActionParameters(definition, { target: "spotify" }), { target: "spotify" });
  assert.throws(() => validateActionParameters(definition, { target: "spotify", other: "x" }), { code: "ACTION_PARAMETERS_INVALID" });
  assert.throws(() => validateActionParameters(definition, {}), { code: "ACTION_PARAMETERS_INVALID" });
});

// --- 4. approval-required actions do not run without approval ---------------

test("an approval-required action stops at approval_required without an approval", async () => {
  const seen = [];
  const service = createActionService({ registry: fixtureRegistry({ seen }), audit: recordingAudit().audit });
  const result = await service.submit({ actionId: "app.test.gated", parameters: { target: "spotify" }, origin: "api" });

  assert.equal(result.status, "approval_required");
  assert.equal(result.executed, false);
  assert.equal(result.result, null);
  assert.equal(result.error.code, "ACTION_APPROVAL_REQUIRED");
  assert.equal(result.approval.required, true);
  assert.equal(result.approval.status, "pending");
  assert.equal(seen.length, 0, "the executor must not run without an approval");
});

test("an explicit approval lets the same action through, and only then", async () => {
  const seen = [];
  const service = createActionService({ registry: fixtureRegistry({ seen }), audit: recordingAudit().audit });
  const result = await service.submit({ actionId: "app.test.gated", parameters: { target: "spotify" }, origin: "api", approval: APPROVAL });

  assert.equal(result.status, "completed");
  assert.equal(result.approval.status, "approved");
  assert.equal(result.approval.decidedBy, "felix");
  assert.deepEqual(statuses(result), ["created", "validated", "approved", "executing", "completed"]);
  assert.equal(seen.length, 1);
});

test("medium and high risk always require approval, even if a definition claims otherwise", () => {
  const registry = createActionRegistry([
    { id: "app.escalate.check", description: "d", risk: "medium", requiresApproval: false, parameters: {}, executor: null },
    { id: "file.escalate.check", description: "d", risk: "high", requiresApproval: false, parameters: {}, executor: null },
    { id: "jarvis.escalate.check", description: "d", risk: "low", requiresApproval: true, parameters: {}, executor: null }
  ]);
  assert.equal(requiresApproval(registry.resolve("app.escalate.check")), true);
  assert.equal(requiresApproval(registry.resolve("file.escalate.check")), true);
  // ... and the policy only ever escalates: a low-risk action that its own
  // definition marks as approval-required stays gated.
  assert.equal(requiresApproval(registry.resolve("jarvis.escalate.check")), true);
});

test("a malformed approval is never mistaken for a granted one", async () => {
  const seen = [];
  const service = createActionService({ registry: fixtureRegistry({ seen }), audit: recordingAudit().audit });
  for (const approval of [{ decision: "yes", decidedBy: "felix" }, { decision: "approve" }, { decidedBy: "felix" }, "approve", []]) {
    const result = await service.submit({ actionId: "app.test.gated", parameters: { target: "spotify" }, origin: "api", approval });
    assert.notEqual(result.status, "completed");
    assert.equal(result.executed, false);
  }
  assert.equal(seen.length, 0);
  // A truthy-looking object is not a decision either.
  assert.equal(normalizeApproval(null), null);
  assert.throws(() => normalizeApproval({ decision: "approve", decidedBy: "" }), { code: "ACTION_REQUEST_INVALID" });
});

// --- 5. a rejected action is not executed -----------------------------------

test("an explicitly rejected approval terminates the request unexecuted", async () => {
  const seen = [];
  const service = createActionService({ registry: fixtureRegistry({ seen }), audit: recordingAudit().audit });
  const result = await service.submit({
    actionId: "app.test.gated",
    parameters: { target: "spotify" },
    origin: "api",
    approval: { decision: "reject", decidedBy: "felix", note: "nicht jetzt" }
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.executed, false);
  assert.equal(result.result, null);
  assert.equal(result.error.code, "ACTION_APPROVAL_REJECTED");
  assert.equal(result.approval.status, "rejected");
  assert.equal(seen.length, 0);
});

test("no lifecycle path leads from approval_required or rejected to execution", () => {
  for (const status of ACTION_STATUSES) {
    assert.equal(canTransition("rejected", status), false, `rejected must be terminal (${status})`);
    assert.equal(canTransition("completed", status), false);
    assert.equal(canTransition("failed", status), false);
  }
  assert.equal(canTransition("approval_required", "executing"), false);
  assert.equal(canTransition("approval_required", "completed"), false);
  assert.equal(canTransition("created", "executing"), false);
});

// --- 6. a registered executor only ever receives validated data -------------

test("the executor receives exactly the validated, frozen parameters and a fixed context", async () => {
  const seen = [];
  const service = createActionService({ registry: fixtureRegistry({ seen }), audit: recordingAudit().audit });
  await service.submit({
    actionId: "jarvis.test.safe",
    parameters: { mode: "b" },
    origin: "test",
    // None of this may reach the executor.
    command: "Start-Process spotify.exe",
    question: "Öffne Spotify.",
    requestId: "act_1_deadbeef"
  });

  assert.equal(seen.length, 1);
  const { parameters, context } = seen[0];
  assert.deepEqual(parameters, { mode: "b" });
  assert.ok(Object.isFrozen(parameters));
  assert.deepEqual(Object.keys(context).sort(), ["actionId", "registry", "requestId"]);
  assert.equal(context.actionId, "jarvis.test.safe");
  const forwarded = JSON.stringify({ parameters, actionId: context.actionId, requestId: context.requestId });
  assert.equal(forwarded.includes("Start-Process"), false);
  assert.equal(forwarded.includes("Öffne Spotify"), false);
});

test("an executor that throws fails the request with a masked, bounded error", async () => {
  const registry = createActionRegistry([{
    id: "jarvis.test.boom",
    description: "Throws.",
    risk: "low",
    requiresApproval: false,
    parameters: {},
    executor: () => { throw new Error("token=sk-abcdefgh12345678 exploded"); }
  }]);
  const service = createActionService({ registry, audit: recordingAudit().audit });
  const result = await service.submit({ actionId: "jarvis.test.boom", origin: "test" });

  assert.equal(result.status, "failed");
  assert.equal(result.executed, false);
  assert.equal(result.error.code, "ACTION_EXECUTION_FAILED");
  assert.equal(result.error.message.includes("sk-abcdefgh12345678"), false);
});

test("a declared action without an executor fails closed, even after approval", async () => {
  const service = createActionService({ registry: fixtureRegistry(), audit: recordingAudit().audit });
  const result = await service.submit({ actionId: "file.test.declared", origin: "api", approval: APPROVAL });

  assert.equal(result.status, "failed");
  assert.equal(result.executed, false);
  assert.equal(result.result, null);
  assert.equal(result.error.code, "ACTION_EXECUTOR_UNAVAILABLE");
});

// --- 7. free shell commands are structurally impossible ---------------------

test("the action service exposes no generic command or shell entry point", () => {
  const service = createActionService({ registry: fixtureRegistry(), audit: recordingAudit().audit });
  for (const name of ["run", "exec", "execute", "shell", "spawn", "command"]) {
    assert.equal(typeof service[name], "undefined", `service must not expose ${name}()`);
  }
  assert.deepEqual(Object.keys(service).sort(), ["registry", "submit"]);
});

test("a command-shaped request carries no command anywhere - it is simply an unregistered action", async () => {
  const service = createActionService({ registry: fixtureRegistry(), audit: recordingAudit().audit });
  const result = await service.submit({ command: "Start-Process spotify.exe", shell: "powershell", origin: "api" });

  assert.equal(result.status, "rejected");
  assert.equal(result.error.code, "ACTION_NOT_REGISTERED");
  assert.equal(JSON.stringify(result).includes("Start-Process"), false);
  assert.equal(JSON.stringify(result).includes("powershell"), false);
});

test("a registry definition can never carry a command string instead of a function", () => {
  const base = { id: "app.bad.entry", description: "d", risk: "low", requiresApproval: false, parameters: {} };
  assert.throws(() => createActionRegistry([{ ...base, executor: "Start-Process spotify.exe" }]), /executor must be a function or null/);
  assert.throws(() => createActionRegistry([{ ...base, executor: undefined }]), /executor must be a function or null/);
  // Free-form parameter types do not exist, so no action can accept a path
  // or a command fragment as a value.
  assert.throws(
    () => createActionRegistry([{ ...base, executor: null, parameters: { path: { type: "string", maxLength: 200 } } }]),
    /only the "enum" parameter type is supported/
  );
});

test("definitions outside the allowed namespaces are refused at construction time", () => {
  const base = { description: "d", risk: "low", requiresApproval: false, parameters: {}, executor: null };
  for (const id of ["shell.run", "powershell.exec", "open", "APP.OPEN", "app", "os.spawn"]) {
    assert.throws(() => createActionRegistry([{ ...base, id }]), /not a valid, namespaced action id/, id);
  }
  assert.throws(() => createActionRegistry([{ ...base, id: "app.open" }, { ...base, id: "app.open" }]), /duplicate action id/);
  assert.throws(() => createActionRegistry([{ ...base, id: "app.open", risk: "critical" }]), /risk must be one of/);
  assert.throws(() => createActionRegistry([{ ...base, id: "app.open", requiresApproval: "yes" }]), /requiresApproval must be an explicit boolean/);
});

// --- 8. audit entries on the relevant transitions ---------------------------

test("every lifecycle transition writes exactly one audit entry", async () => {
  const { entries, audit } = recordingAudit();
  const service = createActionService({ registry: fixtureRegistry(), audit });
  await service.submit({ actionId: "app.test.gated", parameters: { target: "spotify" }, origin: "api", approval: APPROVAL });

  assert.deepEqual(entries.map((entry) => entry.status), ["created", "validated", "approved", "executing", "completed"]);
  assert.deepEqual(entries.map((entry) => entry.event), [
    "action_request_created", "action_request_validated", "action_request_approved",
    "action_request_executing", "action_request_completed"
  ]);
  const requestIds = new Set(entries.map((entry) => entry.requestId));
  assert.equal(requestIds.size, 1, "all entries of one request share its request id");
  const last = entries.at(-1);
  assert.equal(last.safeMetadata.actionId, "app.test.gated");
  assert.equal(last.safeMetadata.origin, "api");
  assert.equal(last.safeMetadata.risk, "medium");
  assert.equal(last.safeMetadata.approvalStatus, "approved");
  assert.equal(last.safeMetadata.decidedBy, "felix");
  assert.equal(last.safeMetadata.parameters, "target=spotify");
});

test("denials and failures are audited with their safe error code", async () => {
  const { entries, audit } = recordingAudit();
  const service = createActionService({ registry: fixtureRegistry(), audit });

  await service.submit({ actionId: "email.send", origin: "api" });
  assert.equal(entries.at(-1).event, "action_request_rejected");
  assert.equal(entries.at(-1).safeMetadata.errorCode, "ACTION_NOT_REGISTERED");
  // The *requested* id is recorded even though it was denied - that is the
  // point of the audit trail. "unresolved" is reserved for a request that
  // never named an action at all (the R2 -> R4 bridge case).
  assert.equal(entries.at(-1).safeMetadata.actionId, "email.send");

  await service.submit({ actionId: "app.test.gated", parameters: { target: "spotify" }, origin: "api" });
  assert.equal(entries.at(-1).event, "action_request_approval_required");
  assert.equal(entries.at(-1).safeMetadata.approvalStatus, "pending");

  await service.submit({ actionId: "file.test.declared", origin: "api", approval: APPROVAL });
  assert.equal(entries.at(-1).event, "action_request_failed");
  assert.equal(entries.at(-1).level, "error");
  assert.equal(entries.at(-1).safeMetadata.errorCode, "ACTION_EXECUTOR_UNAVAILABLE");
});

test("the audit never writes the executor result and never breaks a decision", async () => {
  const registry = createActionRegistry([{
    id: "jarvis.test.secretive",
    description: "Returns something that must not be logged.",
    risk: "low",
    requiresApproval: false,
    parameters: {},
    executor: () => ({ secret: "sk-abcdefgh12345678" })
  }]);
  const entries = [];
  const audit = createActionAudit({ logger: { log: async (entry) => { entries.push(entry); throw new Error("disk full"); } } });
  const service = createActionService({ registry, audit });
  const result = await service.submit({ actionId: "jarvis.test.secretive", origin: "test" });

  // A failing audit writer must not turn a completed action into an error.
  assert.equal(result.status, "completed");
  assert.equal(JSON.stringify(entries).includes("sk-abcdefgh12345678"), false);
});

test("the action audit events and error codes are registered in the central lists", () => {
  for (const event of ACTION_AUDIT_EVENTS) assert.ok(KNOWN_LOG_EVENTS.includes(event), `missing log event ${event}`);
  for (const code of ["ACTION_NOT_REGISTERED", "ACTION_PARAMETERS_INVALID", "ACTION_APPROVAL_REQUIRED", "ACTION_APPROVAL_REJECTED", "ACTION_EXECUTOR_UNAVAILABLE", "ACTION_EXECUTION_FAILED", "ACTION_REQUEST_INVALID"]) {
    assert.ok(ERROR_CODES.includes(code), `missing error code ${code}`);
  }
});

// --- policy unit checks ------------------------------------------------------

test("the policy returns exactly one of three outcomes and never invents an approval", () => {
  const registry = fixtureRegistry();
  const gated = registry.resolve("app.test.gated");
  const safe = registry.resolve("jarvis.test.safe");
  assert.equal(evaluateActionPolicy(safe, null).outcome, "allowed");
  assert.equal(evaluateActionPolicy(gated, null).outcome, "approval_required");
  assert.equal(evaluateActionPolicy(gated, { decision: "approve", decidedBy: "felix" }).outcome, "allowed");
  assert.equal(evaluateActionPolicy(gated, { decision: "reject", decidedBy: "felix" }).outcome, "rejected");
  // A rejection wins over everything, even for an action that needs no approval.
  assert.equal(evaluateActionPolicy(safe, { decision: "reject", decidedBy: "felix" }).outcome, "rejected");
});

// --- R2 -> R4 seam ------------------------------------------------------------

test("the intent bridge only builds a request for an action intent, and never resolves one", () => {
  assert.equal(buildActionRequestFromIntent({ intent: "knowledge" }), null);
  assert.equal(buildActionRequestFromIntent({ intent: "operational" }), null);
  assert.equal(buildActionRequestFromIntent(null), null);
  const built = buildActionRequestFromIntent({ intent: "action", confidence: "high" });
  assert.equal(built.actionId, null, "R4 deliberately performs no free-text -> action mapping");
  assert.equal(built.origin, "jarvis-ask");
  assert.equal(built.approval, null);
});

function proxyRequest(body) {
  const req = new EventEmitter();
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  req.socket = new EventEmitter();
  req.destroy = () => {};
  queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function proxyResponse() {
  const res = new EventEmitter();
  res.headers = new Map();
  res.statusCode = 200;
  res.writableEnded = false;
  res.destroyed = false;
  res.body = "";
  res.setHeader = (n, v) => res.headers.set(String(n).toLowerCase(), String(v));
  res.getHeader = (n) => res.headers.get(String(n).toLowerCase());
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    return res;
  };
  res.end = (v = "") => { res.body = String(v); res.writableEnded = true; };
  res.json = () => JSON.parse(res.body);
  return res;
}

test("an action-shaped Jarvis question is denied by the action pipeline, with an audit handle", async () => {
  const { entries, audit } = recordingAudit();
  const service = createActionService({ registry: fixtureRegistry(), audit });
  let knowledgeCalls = 0;
  const handler = createJarvisConsoleHandler({
    env: { [KNOWLEDGE_TOKEN_ENV_VAR]: "test-generic-knowledge-route-token-0123456789ab" },
    knowledgeHandler: async () => { knowledgeCalls += 1; },
    actionService: service
  });
  const res = proxyResponse();
  await handler(proxyRequest({ question: "Öffne Spotify." }), res);

  const payload = res.json();
  assert.equal(knowledgeCalls, 0, "an action question must never reach the knowledge route");
  assert.equal(payload.intent, "action");
  assert.equal(payload.executionAvailable, false);
  assert.equal(payload.actionStatus, "rejected");
  assert.equal(payload.actionErrorCode, "ACTION_NOT_REGISTERED");
  assert.match(payload.actionRequestId, /^act_\d+_[0-9a-f]{8}$/);
  assert.equal(entries.at(-1).event, "action_request_rejected");
  // The question itself is never part of the audit trail.
  assert.equal(JSON.stringify(entries).includes("Spotify"), false);
});

test("a knowledge question never enters the action pipeline", async () => {
  const { entries, audit } = recordingAudit();
  const service = createActionService({ registry: fixtureRegistry(), audit });
  const handler = createJarvisConsoleHandler({
    env: { [KNOWLEDGE_TOKEN_ENV_VAR]: "test-generic-knowledge-route-token-0123456789ab" },
    knowledgeHandler: async (_req, res) => { res.statusCode = 200; res.end(JSON.stringify({ schemaVersion: "1.0", state: "ok", answer: "A", sources: [], warnings: [] })); },
    actionService: service
  });
  const res = proxyResponse();
  await handler(proxyRequest({ question: "Was sagt DEC-012?" }), res);

  assert.equal(entries.length, 0, "a knowledge question must not create an action request");
  assert.equal(res.json().answer, "A");
});
