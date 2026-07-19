import { RouterError } from "./contracts.js";

const ACTIONS = Object.freeze([
  { name: "router.status", enabled: true, simulationAllowed: true, executionAllowed: false, riskLevel: "low", requiresConfirmation: false, description: "Liest den sicheren Betriebsstatus des Routers." },
  { name: "router.explain", enabled: true, simulationAllowed: true, executionAllowed: false, riskLevel: "low", requiresConfirmation: false, description: "Erklaert eine Router-Entscheidung ohne externe Ausfuehrung." },
  { name: "tasks.list", enabled: true, simulationAllowed: true, executionAllowed: false, riskLevel: "low", requiresConfirmation: false, description: "Bereitet das Lesen vorhandener Aufgaben als Simulation vor." },
  { name: "projects.list", enabled: true, simulationAllowed: true, executionAllowed: false, riskLevel: "low", requiresConfirmation: false, description: "Bereitet eine sichere Projektliste als Simulation vor." },
  { name: "projects.status", enabled: true, simulationAllowed: true, executionAllowed: false, riskLevel: "low", requiresConfirmation: false, description: "Bereitet sichere Projektstatusdaten als Simulation vor." },
  { name: "cockpit.preview", enabled: true, simulationAllowed: true, executionAllowed: false, riskLevel: "low", requiresConfirmation: false, description: "Erzeugt nur eine Cockpit-Vorschau ohne Zustandsaenderung." }
].map((action) => Object.freeze(action)));

const BY_NAME = new Map(ACTIONS.map((action) => [action.name, action]));

export function listPublicActions() {
  return ACTIONS.map((action) => ({ ...action }));
}

export function countSimulationActions() {
  return ACTIONS.filter((action) => action.enabled && action.simulationAllowed).length;
}

export function evaluateAction(actionName, mode = "simulate") {
  const action = BY_NAME.get(actionName);
  if (!action || !action.enabled) throw new RouterError("ACTION_NOT_ALLOWLISTED", "The proposed action is not allowlisted.");
  if (mode === "execute") throw new RouterError("EXECUTION_DISABLED", "Execute mode is disabled for the router API.");
  if (!action.simulationAllowed) throw new RouterError("ACTION_NOT_ALLOWLISTED", "The proposed action is not allowed in simulation mode.");
  return Object.freeze({ allowed: true, action: action.name, riskLevel: action.riskLevel, requiresConfirmation: action.requiresConfirmation });
}
