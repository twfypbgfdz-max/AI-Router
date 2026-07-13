const MODES = new Set(["success", "failure", "failure_executor", "failure_reviewer", "timeout"]);
const ROLES = new Set(["planner", "executor", "reviewer", "synthesizer"]);

function abortError() {
  const error = new Error("Mock simulation cancelled.");
  error.name = "AbortError";
  return error;
}

function wait(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isMockSimulationMode(value) { return MODES.has(value); }

export function createMockAdapter({ stepDelayMs = 1_100 } = {}) {
  const adapter = {
    async run({ task, runId, signal, simulationMode = "success", routePlan, approvalSimulation = false }) {
      if (!isMockSimulationMode(simulationMode)) throw new Error("Unsupported simulation mode.");
      const events = [];
      const event = (phase, message) => events.push({ type: "simulation", phase, message, runId });
      event("analysis_started", "Analyse gestartet");
      await wait(stepDelayMs, signal);
      event("route_selected", "Route gewählt");
      await wait(stepDelayMs, signal);
      const planOnly = routePlan?.approvalRequired === true && !approvalSimulation;
      event("processing", approvalSimulation ? "Freigabe-Simulation wird verarbeitet" : (planOnly ? "Route-Plan wird geprüft" : "Aufgabe wird verarbeitet"));
      await wait(stepDelayMs, signal);
      if (approvalSimulation) {
        event("approval_simulated", "Freigabe registriert; riskante Aktion bleibt unausgeführt");
        await wait(stepDelayMs, signal);
        return { exitCode: 0, issues: [], stderr: "", events, resultSummary: "Freigabe wurde registriert. Die riskante Aktion wurde nicht real ausgeführt. Es wurde ausschließlich eine sichere Simulation durchgeführt." };
      }
      if (simulationMode === "timeout") {
        event("waiting_for_timeout", "Simulation wartet auf den kontrollierten Timeout");
        await wait(stepDelayMs * 100, signal);
      }
      if (simulationMode === "failure") {
        event("simulated_failure", "Kontrollierter Simulationsfehler");
        return { exitCode: 1, issues: [], stderr: "Simulated adapter failure.", events, resultSummary: null };
      }
      if (planOnly) {
        event("plan_only", "Freigabe-Gate aktiv; keine Aktion wird ausgeführt");
        await wait(stepDelayMs, signal);
        return { exitCode: 0, issues: [], stderr: "", events, resultSummary: "Nur der Route-Plan wurde simuliert. Die freigabepflichtige Aktion wurde nicht ausgeführt." };
      }
      event("result_created", "Ergebnis wird erstellt");
      await wait(stepDelayMs, signal);
      return { exitCode: 0, issues: [], stderr: "", events, resultSummary: "Die Aufgabe wurde im Simulationsmodus erfolgreich verarbeitet. Es wurde kein externes Modell gestartet." };
    },
    async runRole({ role, signal, simulationMode = "success", approvalSimulation = false }) {
      if (!ROLES.has(role)) throw new Error("Unsupported mock workflow role.");
      if (!isMockSimulationMode(simulationMode)) throw new Error("Unsupported simulation mode.");
      const events = [{ type: "workflow_role", phase: role, status: "running", message: `${role} simulation started.` }];
      await wait(stepDelayMs, signal);
      if (simulationMode === "timeout" && role === "executor") await wait(stepDelayMs * 100, signal);
      if ((simulationMode === "failure" || simulationMode === "failure_executor") && role === "executor") return { exitCode: 1, issues: [], stderr: "Controlled executor failure.", events, resultSummary: null };
      if (simulationMode === "failure_reviewer" && role === "reviewer") return { exitCode: 1, issues: [], stderr: "Controlled reviewer failure.", events, resultSummary: null };
      const summaries = {
        planner: "Planer-Simulation: Ziel verstanden, sichere Schritte und Risiken bestimmt, erwartetes Mock-Ergebnis festgelegt.",
        executor: "Ausführer-Simulation: Aufgabe im Mock-Modus verarbeitet. Keine externe KI und keine reale Aktion wurden ausgeführt.",
        reviewer: "Prüfer-Simulation: Plan und Mock-Ausführung geprüft; Widersprüche und offene Punkte wurden begrenzt bewertet.",
        synthesizer: approvalSimulation
          ? "Freigabe wurde registriert. Der sichere Mock-Workflow wurde zusammengeführt. Die riskante Aktion wurde nicht real ausgeführt; alles war nur Simulation."
          : "Zusammenführung: Der lokale Mock-Workflow wurde kompakt abgeschlossen. Alle Rollen und Ergebnisse waren ausschließlich Simulation."
      };
      events.push({ type: "workflow_role", phase: role, status: "succeeded", message: `${role} simulation completed.` });
      return { exitCode: 0, issues: [], stderr: "", events, resultSummary: summaries[role] };
    }
  };
  return adapter;
}

const productionMockAdapter = createMockAdapter();
export const runMock = productionMockAdapter.run;
export const runMockRole = productionMockAdapter.runRole;
