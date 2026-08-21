// R4 - Action Foundation. The allowlist: the only place that decides which
// actions exist at all, what parameters each one accepts, how risky it is,
// and which executor (if any) may run it.
//
// Two hard rules this file exists to enforce:
//   1. Default deny. resolve() throws for anything not registered here.
//      There is no dynamic registration path at runtime, no wildcard, no
//      "unknown but low risk" fallback.
//   2. No free-form strings. The only supported parameter type is "enum" -
//      a closed list of literal values fixed at definition time. That is a
//      deliberate restriction, not an unfinished one: a free-form string
//      parameter is exactly the surface through which a model-produced
//      shell fragment or path could reach an executor. Adding another
//      parameter type is a conscious registry-level decision (with its own
//      validator and its own tests), never something a caller can do.
//
// See action-types.js's boundary note on orchestrator/action-registry.js -
// this is the Jarvis action layer, that one is the Router API allowlist.
import { RouterError } from "../contracts.js";
import { ACTION_RISK_LEVELS, isValidActionId } from "./action-types.js";
import { appLauncher } from "./app-launcher.js";

const MAX_ENUM_VALUES = 32;
const MAX_ENUM_VALUE_LENGTH = 64;

function definitionError(message) {
  // A malformed definition is a programming error in this repository, not a
  // caller error - it must fail loudly at construction time, not degrade
  // into a runtime rejection that looks like a denied request.
  return new Error(`Invalid action definition: ${message}`);
}

function freezeParameterSpec(actionId, name, spec) {
  if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(name)) throw definitionError(`${actionId}: parameter name "${name}" is not a plain identifier.`);
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw definitionError(`${actionId}.${name}: parameter spec must be an object.`);
  if (spec.type !== "enum") throw definitionError(`${actionId}.${name}: only the "enum" parameter type is supported in R4.`);
  if (!Array.isArray(spec.values) || spec.values.length === 0) throw definitionError(`${actionId}.${name}: enum values must be a non-empty array.`);
  if (spec.values.length > MAX_ENUM_VALUES) throw definitionError(`${actionId}.${name}: too many enum values.`);
  for (const value of spec.values) {
    if (typeof value !== "string" || !value || value.length > MAX_ENUM_VALUE_LENGTH) throw definitionError(`${actionId}.${name}: enum values must be short non-empty strings.`);
  }
  if (new Set(spec.values).size !== spec.values.length) throw definitionError(`${actionId}.${name}: enum values must be unique.`);
  return Object.freeze({ type: "enum", required: spec.required === true, values: Object.freeze([...spec.values]) });
}

function freezeDefinition(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw definitionError("definition must be an object.");
  const id = raw.id;
  if (!isValidActionId(id)) throw definitionError(`"${String(id)}" is not a valid, namespaced action id.`);
  if (typeof raw.description !== "string" || !raw.description.trim()) throw definitionError(`${id}: description is required.`);
  if (!ACTION_RISK_LEVELS.includes(raw.risk)) throw definitionError(`${id}: risk must be one of ${ACTION_RISK_LEVELS.join(", ")}.`);
  if (typeof raw.requiresApproval !== "boolean") throw definitionError(`${id}: requiresApproval must be an explicit boolean.`);
  // Only null (declared but not executable) or a function. There is
  // deliberately no string/command form: an executor is code in this
  // repository, never a command line assembled from a definition.
  if (raw.executor !== null && typeof raw.executor !== "function") throw definitionError(`${id}: executor must be a function or null.`);
  const rawParameters = raw.parameters ?? {};
  if (!rawParameters || typeof rawParameters !== "object" || Array.isArray(rawParameters)) throw definitionError(`${id}: parameters must be an object.`);
  const parameters = Object.freeze(Object.fromEntries(
    Object.entries(rawParameters).map(([name, spec]) => [name, freezeParameterSpec(id, name, spec)])
  ));
  return Object.freeze({
    id,
    description: raw.description.trim(),
    risk: raw.risk,
    requiresApproval: raw.requiresApproval,
    parameters,
    executor: raw.executor,
    // Purely informational, surfaced by describe() so a caller can tell
    // "not allowed" apart from "allowed but nothing implements it yet".
    executable: typeof raw.executor === "function"
  });
}

// Validates parameters against the definition's closed schema. Strict in
// both directions: a missing required parameter and an unknown extra
// parameter are equally fatal, so an executor can never receive a key its
// definition never described.
export function validateActionParameters(definition, input) {
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) {
    throw new RouterError("ACTION_PARAMETERS_INVALID", "Action parameters must be a JSON object.");
  }
  const provided = input ?? {};
  const specs = definition.parameters;
  for (const key of Object.keys(provided)) {
    if (!Object.hasOwn(specs, key)) throw new RouterError("ACTION_PARAMETERS_INVALID", `Unknown parameter "${key}" for action ${definition.id}.`);
  }
  const validated = {};
  for (const [name, spec] of Object.entries(specs)) {
    const value = provided[name];
    if (value === undefined || value === null) {
      if (spec.required) throw new RouterError("ACTION_PARAMETERS_INVALID", `Parameter "${name}" is required for action ${definition.id}.`);
      continue;
    }
    if (typeof value !== "string") throw new RouterError("ACTION_PARAMETERS_INVALID", `Parameter "${name}" must be a string.`);
    if (!spec.values.includes(value)) throw new RouterError("ACTION_PARAMETERS_INVALID", `Parameter "${name}" is not an allowed value for action ${definition.id}.`);
    validated[name] = value;
  }
  return Object.freeze(validated);
}

export function createActionRegistry(definitions = []) {
  if (!Array.isArray(definitions)) throw definitionError("definitions must be an array.");
  const byId = new Map();
  for (const raw of definitions) {
    const definition = freezeDefinition(raw);
    if (byId.has(definition.id)) throw definitionError(`${definition.id}: duplicate action id.`);
    byId.set(definition.id, definition);
  }
  return Object.freeze({
    has(actionId) { return byId.has(actionId); },
    // Default deny: the single lookup every caller must go through.
    resolve(actionId) {
      const definition = byId.get(actionId);
      if (!definition) throw new RouterError("ACTION_NOT_REGISTERED", "The requested action is not registered.");
      return definition;
    },
    // Safe, executor-free projection for callers and responses - an
    // executor function must never be handed out of the registry.
    describe() {
      return [...byId.values()].map(({ id, description, risk, requiresApproval, parameters, executable }) => ({
        id,
        description,
        risk,
        requiresApproval,
        executable,
        parameters: Object.fromEntries(Object.entries(parameters).map(([name, spec]) => [name, { type: spec.type, required: spec.required, values: [...spec.values] }]))
      }));
    },
    get size() { return byId.size; }
  });
}

// --- The R4 default registry -----------------------------------------------
//
// Two entries, both justifiable today; no speculative library. Everything
// else the R4 spec names as a namespace (file.*, calendar.*, email.*,
// system.*) is intentionally empty: registering an action there without an
// executor and without a Felix-approved policy would only create the
// appearance of capability.
const DEFAULT_DEFINITIONS = [
  {
    // Read-only introspection of this very registry. No side effect, no I/O,
    // no external call - the one action that is genuinely safe to execute
    // in R4, and the reference implementation of the executor contract.
    id: "jarvis.action.list",
    description: "Listet die registrierten Actions inklusive Risikoklasse und Freigabebedarf.",
    risk: "low",
    requiresApproval: false,
    parameters: {},
    executor: (_parameters, { registry }) => ({ actions: registry.describe() })
  },
  {
    // R6 - First Safe Executor. Now genuinely executable, but only for the
    // two apps app-launcher.js's fixed allowlist knows about - adding a
    // third target here without a matching app-launcher.js entry would just
    // turn it into an APP_NOT_ALLOWED failure at execution time, not a
    // security hole (app-launcher.js re-checks its own allowlist rather than
    // trusting this parameter). The executor call is exactly
    // `appLauncher.launch(parameters.target)` - a fixed, code-defined
    // function call with a closed enum value as its only input, never a
    // command string, path or shell invocation.
    id: "app.open",
    description: "Oeffnet eine bekannte Anwendung (Spotify oder Obsidian). Freigabepflichtig.",
    risk: "medium",
    requiresApproval: true,
    parameters: { target: { type: "enum", required: true, values: ["spotify", "obsidian"] } },
    executor: (parameters) => appLauncher.launch(parameters.target)
  }
];

export const actionRegistry = createActionRegistry(DEFAULT_DEFINITIONS);
