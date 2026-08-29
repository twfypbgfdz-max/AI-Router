import test from "node:test";
import assert from "node:assert/strict";
import { planJarvisRequest, TASK_CLASSES } from "../orchestrator/jarvis/request-planner.js";
import { classifyIntent } from "../orchestrator/intent/intent-router.js";
import { RouterError } from "../orchestrator/contracts.js";

// 1. Exact project name -> read-only project analysis.
test("1. exact project name: read-only analysis on AI-Router", () => {
  const plan = planJarvisRequest({ question: "Prüf den AI-Router." });
  assert.equal(plan.project.status, "resolved");
  assert.equal(plan.project.project.id, "ai-router");
  assert.equal(plan.taskClass, "code_analysis");
  assert.equal(plan.mode, "read_only");
  assert.equal(plan.agent.id, "codex-cli");
  assert.equal(plan.agent.available, true);
  assert.equal(plan.originalRequest, "Prüf den AI-Router.");
});

// 2. Alias resolves to the same project, continuing work reads as implementation.
test("2. alias + 'weiter machen' resolves to AI-Router as a code_implementation task", () => {
  const plan = planJarvisRequest({ question: "Jarvis, mach beim AI-Router mit dem nächsten Block weiter." });
  assert.equal(plan.project.status, "resolved");
  assert.equal(plan.project.project.id, "ai-router");
  assert.equal(plan.taskClass, "code_implementation");
  assert.equal(plan.mode, "write");
  assert.equal(plan.agent.id, "claude-code");
  assert.equal(plan.agent.available, false, "no real Claude-Code executor exists yet");
});

// 3. Implementation order ("Beheb den Fehler") -> write, distinct from case 1's "Prüf".
test("3. implementation verb ('beheb') on AI-Router is a write task", () => {
  const plan = planJarvisRequest({ question: "Beheb den Fehler im AI-Router." });
  assert.equal(plan.project.project.id, "ai-router");
  assert.equal(plan.taskClass, "code_implementation");
  assert.equal(plan.mode, "write");
  assert.equal(plan.governance.writeAccessRequired, true);
  assert.equal(plan.governance.approvalRequired, true);
});

// 4. Read-only analysis on a different, unambiguous project (Cockpit).
test("4. read-only analysis on Cockpit", () => {
  const plan = planJarvisRequest({ question: "Analysiere den aktuellen Stand vom Cockpit." });
  assert.equal(plan.project.project.id, "felix-cockpit");
  assert.equal(plan.taskClass, "code_analysis");
  assert.equal(plan.mode, "read_only");
});

// 5. Ambiguous project reference -> controlled ambiguity, never a guess.
test("5. ambiguous project reference fails closed with candidates, no guessed path", () => {
  const plan = planJarvisRequest({ question: "Wie geht es mit dem Plateau-Brecher voran?" });
  assert.equal(plan.project.status, "ambiguous");
  assert.ok(Array.isArray(plan.project.candidates) && plan.project.candidates.length >= 2);
  assert.equal(plan.prompt, null, "no prompt is built without one resolved project");
});

// 6. Unknown project -> never hallucinate a repo path.
test("6. unknown project is reported, never mapped to a guessed path", () => {
  const plan = planJarvisRequest({ question: "Schau dir mal das Projekt Foobar-Nichtvorhanden an." });
  assert.equal(plan.project.status, "unknown");
  assert.equal(plan.project.mention, "Foobar-Nichtvorhanden");
  assert.equal(plan.prompt, null);
});

// 7. No project named at all -> clean defined "none" state, not an arbitrary repo.
test("7. request without any project stays a plain knowledge question", () => {
  const plan = planJarvisRequest({ question: "Was ist eigentlich ein Deload?" });
  assert.equal(plan.project.status, "none");
  assert.equal(plan.taskClass, "knowledge_question");
  assert.equal(plan.mode, "read_only");
  assert.equal(plan.agent.id, "jarvis");
});

// 8. Write task marks approval/write-access requirements explicitly.
test("8. write task is explicitly marked for later approval", () => {
  const plan = planJarvisRequest({ question: "Implementiere den Claude-Code-Executor im AI-Router." });
  assert.equal(plan.mode, "write");
  assert.equal(plan.governance.writeAccessRequired, true);
  assert.equal(plan.governance.approvalRequired, true);
});

// 9. A pure knowledge/architecture question must not be misclassified as a coding run.
test("9. knowledge question about the router's own workings stays knowledge, not code", () => {
  const plan = planJarvisRequest({ question: "Wie funktioniert der AI-Router?" });
  assert.equal(plan.taskClass, "knowledge_question");
  assert.equal(plan.mode, "read_only");
  assert.equal(plan.agent.id, "jarvis");
});

// 10. Existing Jarvis intent classification must not regress from adding this layer.
test("10. underlying classifyIntent behavior is untouched by the planner", () => {
  assert.equal(classifyIntent({ question: "Was sagt DEC-012?" }).intent, "knowledge");
  assert.equal(classifyIntent({ question: "Läuft der AI-Router?" }).intent, "system");
  assert.equal(classifyIntent({ question: "Was steht heute an?" }).intent, "operational");
});

test("system-intent question (explicit route) is a status_query, not a coding task", () => {
  const plan = planJarvisRequest({ question: "Läuft der AI-Router?" });
  assert.equal(plan.taskClass, "status_query");
  assert.equal(plan.agent.id, "jarvis");
  assert.equal(plan.mode, "read_only");
});

test("action-intent question is a local_action with write mode and approval required", () => {
  const plan = planJarvisRequest({ question: "Öffne Spotify." });
  assert.equal(plan.taskClass, "local_action");
  assert.equal(plan.mode, "write");
  assert.equal(plan.governance.approvalRequired, true);
  assert.equal(plan.agent.id, "jarvis-action-layer");
});

test("sessionId passes through unchanged and appears in the generated prompt", () => {
  const plan = planJarvisRequest({ question: "Prüf den AI-Router.", sessionId: "sess_123" });
  assert.equal(plan.sessionId, "sess_123");
  assert.match(plan.prompt, /sess_123/);
});

test("originalRequest is preserved exactly as given, never rewritten", () => {
  const raw = "  Prüf   den   AI-Router.  ";
  const plan = planJarvisRequest({ question: raw });
  assert.equal(plan.originalRequest, raw);
});

test("rejects a missing/empty question instead of guessing intent", () => {
  assert.throws(() => planJarvisRequest({ question: "" }), RouterError);
  assert.throws(() => planJarvisRequest({}), RouterError);
});

test("TASK_CLASSES stays a closed, exhaustive set", () => {
  assert.ok(TASK_CLASSES.includes("code_implementation"));
  assert.ok(TASK_CLASSES.includes("knowledge_question"));
});
