import test from "node:test";
import assert from "node:assert/strict";
import { listProjects, resolveProject } from "../orchestrator/jarvis/project-registry.js";

test("resolves the bare project name", () => {
  const result = resolveProject("AI-Router");
  assert.equal(result.status, "resolved");
  assert.equal(result.project.id, "ai-router");
  assert.match(result.project.path, /AI-Router$/);
});

test("resolves a short alias", () => {
  const result = resolveProject("Router");
  assert.equal(result.status, "resolved");
  assert.equal(result.project.id, "ai-router");
});

test("resolves Command Center by its common alias", () => {
  const result = resolveProject("Command Center");
  assert.equal(result.status, "resolved");
  assert.equal(result.project.id, "felix-command-center");
});

test("resolves Cockpit unambiguously", () => {
  const result = resolveProject("Cockpit");
  assert.equal(result.status, "resolved");
  assert.equal(result.project.id, "felix-cockpit");
});

test("Plateau-Brecher is ambiguous between Personal and Public app", () => {
  const result = resolveProject("Plateau-Brecher");
  assert.equal(result.status, "ambiguous");
  const ids = result.candidates.map((candidate) => candidate.id).sort();
  assert.deepEqual(ids, ["app", "public-app"]);
});

test("Felix Core is ambiguous/unresolvable - never guessed to a single repo", () => {
  const result = resolveProject("Felix Core");
  assert.equal(result.status, "unknown");
});

test("empty text has no project mention at all", () => {
  assert.equal(resolveProject("").status, "none");
  assert.equal(resolveProject("   ").status, "none");
});

test("an unrecognized project name never resolves to a guessed path", () => {
  const result = resolveProject("Voellig-Unbekanntes-Projekt-Xyz");
  assert.equal(result.status, "unknown");
  assert.equal(result.mention, "Voellig-Unbekanntes-Projekt-Xyz");
});

test("every listed project has an absolute Windows path", () => {
  for (const project of listProjects()) {
    assert.match(project.path, /^[A-Za-z]:\\/);
  }
});

test("no alias is silently shared between two projects (construction-time check)", () => {
  // The module already throws at import time if this invariant is broken;
  // reaching this point means the registry built successfully.
  assert.ok(listProjects().length > 0);
});
