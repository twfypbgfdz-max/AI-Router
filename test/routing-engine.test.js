import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalContext, createRoutePlan, TASK_TYPES } from "../orchestrator/routing-engine.js";

test("task type allowlist is complete and deterministic", () => {
  assert.deepEqual([...TASK_TYPES], ["code", "research", "planning", "writing", "obsidian", "social_media", "learning", "career", "finance", "everyday", "unknown"]);
  const examples = new Map([
    ["Analysiere den JavaScript-Code ohne Änderungen.", "code"],
    ["Recherchiere aktuelle Quellen.", "research"],
    ["Erstelle ein Konzept und eine Roadmap.", "planning"],
    ["Formuliere einen kurzen Artikel.", "writing"],
    ["Ordne meine Obsidian-Notizen.", "obsidian"],
    ["Plane einen Instagram Reel-Text.", "social_media"],
    ["Erkläre mir diese Übung zum Lernen.", "learning"],
    ["Überarbeite meinen Lebenslauf.", "career"],
    ["Analysiere mein Finanzbudget.", "finance"],
    ["Plane meine Einkaufsliste.", "everyday"],
    ["Mach dies sinnvoll.", "unknown"]
  ]);
  for (const [task, expected] of examples) assert.equal(createRoutePlan(task).taskType, expected, task);
  assert.deepEqual(createRoutePlan("Analysiere den Code ohne Änderungen."), createRoutePlan("Analysiere den Code ohne Änderungen."));
});

test("route plan exposes only the fixed MVP schema", () => {
  assert.deepEqual(Object.keys(createRoutePlan("Analysiere Code ohne Änderungen.")), [
    "taskType", "recommendedRoute", "executionAdapter", "reason", "complexity", "importance", "risk", "uncertainty", "estimatedUsage", "reviewRequired", "approvalRequired", "warnings"
  ]);
  assert.equal(Object.isFrozen(TASK_TYPES), true);
});

test("read-only code analysis recommends Codex but executes mock safely", () => {
  const plan = createRoutePlan("Analysiere README und Code ohne Änderungen oder Schreibzugriff.");
  assert.equal(plan.taskType, "code");
  assert.equal(plan.recommendedRoute, "codex-cli");
  assert.equal(plan.executionAdapter, "mock");
  assert.equal(plan.risk, "R0");
  assert.equal(plan.approvalRequired, false);
});

test("planning routes remain metadata and never auto-execute an external adapter", () => {
  const plan = createRoutePlan("Erstelle ein Architekturkonzept und eine Roadmap.");
  assert.equal(plan.taskType, "planning");
  assert.equal(plan.recommendedRoute, "claude");
  assert.equal(plan.executionAdapter, "mock");
  assert.match(plan.warnings.join(" "), /nicht automatisch gestartet/i);
});

test("risky actions require approval with at least R3", () => {
  for (const task of ["Committen und pushen", "E-Mail senden", "Kalender ändern", "Etwas kaufen", "Vertrag abschließen", "Rechte ändern"]) {
    const plan = createRoutePlan(task);
    assert.ok(["R3", "R4"].includes(plan.risk), task);
    assert.equal(plan.approvalRequired, true, task);
  }
});

test("productive or destructive actions are R4 and plan-only", () => {
  for (const task of ["Dateien löschen", "In Produktion deployen", "Secrets verändern", "Produktiven Branch pushen", "Zahlung ausführen", "Zugangsdaten weitergeben"]) {
    const plan = createRoutePlan(task);
    assert.equal(plan.risk, "R4", task);
    assert.equal(plan.approvalRequired, true, task);
    assert.equal(plan.executionAdapter, "mock", task);
  }
});

test("negated actions do not trigger false approval and schema has no confidence percentage", () => {
  const plan = createRoutePlan("Code prüfen, aber keine Dateien löschen, nicht committen und nicht pushen.");
  assert.equal(plan.risk, "R0");
  assert.equal(plan.approvalRequired, false);
  assert.equal("confidence" in plan, false);
  assert.equal(JSON.stringify(plan).includes("%"), false);
});

test("approval context derives only bounded consequences, systems and resources", () => {
  const task = "Lösche alle Dateien und pushe auf main";
  const plan = createRoutePlan(task);
  const context = createApprovalContext(task, plan);
  assert.equal(context.plannedAction, task);
  assert.equal(context.executionAdapter, "mock");
  assert.equal(context.reversibility, "irreversible_or_limited");
  assert.ok(context.affectedSystems.includes("Lokales Dateisystem"));
  assert.ok(context.affectedSystems.includes("Git-Repository"));
  assert.ok(context.affectedResources.every((item) => typeof item === "string"));
  assert.equal(createApprovalContext("Nur lesen", createRoutePlan("Nur lesen")), null);
});
