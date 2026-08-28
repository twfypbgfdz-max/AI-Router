import test from "node:test";
import assert from "node:assert/strict";
import { normalizeKnowledgeRequest } from "../orchestrator/knowledge-contract.js";
import { KNOWLEDGE_SCHEMA_VERSION } from "../orchestrator/knowledge-config.js";
import { loadAllowlist } from "../orchestrator/knowledge/document-allowlist.js";
import { RAG_ALLOWLIST_FILE, RAG_TRUTH_SET_FILE } from "../orchestrator/knowledge/rag-config.js";
import {
  enrichCitedSources,
  evaluateCurrentCommitClaims,
  evaluateTruthSample,
  summarizeTruthCase,
  summarizeTruthEvaluation
} from "../orchestrator/knowledge/rag-truth-eval.js";
import { RagTruthError } from "../orchestrator/knowledge/rag-truth-error.js";
import { loadTruthSet } from "../orchestrator/knowledge/rag-truth-set.js";

function expected(overrides = {}) {
  return {
    states: ["partial"],
    knowledgeStates: ["available"],
    warningIncludes: [],
    warningExcludes: [],
    evidenceAnyOf: [{ sourceDoc: "a.md", informationClass: "project_context", sectionValidity: "current", sectionIncludes: "Stand" }],
    answer: {
      concepts: [{ id: "fact", anyOf: ["zehn dokumente", "10 dokumente"], patterns: [] }],
      forbiddenPatterns: [{ id: "old_fact", pattern: "\\b7 dokumente\\b" }],
      currentCommitPolicy: null
    },
    ...overrides
  };
}

function truthCase(expectedOverrides = {}) {
  return { id: "T01", question: "Was gilt?", expected: expected(expectedOverrides) };
}

function retrieval() {
  return {
    knowledgeState: "available",
    results: [{
      sourceDoc: "a.md", section: "Dokument > Stand", similarity: 0.9,
      informationClass: "project_context", sectionValidity: "current"
    }]
  };
}

function payload(overrides = {}) {
  return {
    state: "partial",
    knowledgeState: "available",
    answer: "Die Allowlist hat zehn Dokumente.",
    warnings: [],
    sources: [{ sourceDoc: "a.md", section: "Dokument > Stand", similarity: 0.9 }],
    ...overrides
  };
}

test("a truth sample combines response, semantic answer and server-owned evidence assertions", () => {
  const evaluated = evaluateTruthSample(truthCase(), { payload: payload(), retrieval: retrieval() });
  assert.equal(evaluated.verdict, "pass");
  assert.deepEqual(evaluated.failedAssertions, []);
  assert.equal(evaluated.citedEvidence[0].informationClass, "project_context");
});

test("an answer with the forbidden old fact fails even when state and source are valid", () => {
  const evaluated = evaluateTruthSample(truthCase(), {
    payload: payload({ answer: "Die Allowlist hat 7 Dokumente." }),
    retrieval: retrieval()
  });
  assert.equal(evaluated.verdict, "fail");
  assert.ok(evaluated.failedAssertions.includes("concept:fact"));
  assert.ok(evaluated.failedAssertions.includes("forbidden:old_fact"));
});

test("a numeric truth concept can robustly accept a standalone markdown-formatted 10", () => {
  const testCase = truthCase({
    answer: {
      concepts: [{ id: "fact", anyOf: ["10 dokumente"], patterns: ["\\b10\\b"] }],
      forbiddenPatterns: [],
      currentCommitPolicy: null
    }
  });
  const evaluated = evaluateTruthSample(testCase, {
    payload: payload({ answer: "Die Anzahl der RAG-Allowlist-Dokumente ist **10**." }),
    retrieval: retrieval()
  });
  assert.equal(evaluated.verdict, "pass");
});

function t02Fixture(answer, { sourceDoc = "10_Apps/90_Entscheidungen/DEC-012-Interaktions-und-Boot-Erlebnis-Grenze.md" } = {}) {
  const allowedDocuments = new Set(loadAllowlist(RAG_ALLOWLIST_FILE).documents.map((entry) => entry.relativePath));
  const testCase = loadTruthSet(RAG_TRUTH_SET_FILE, { allowedDocuments }).cases.find((entry) => entry.id === "T02");
  const source = {
    sourceDoc,
    section: "DEC-012 > Entscheidung > Wem das Boot-Erlebnis gehört",
    similarity: 0.7
  };
  return {
    testCase,
    payload: {
      state: "partial",
      knowledgeState: "available",
      answer,
      warnings: [],
      sources: [source]
    },
    retrieval: {
      knowledgeState: "available",
      results: [{
        ...source,
        informationClass: "architecture_rule",
        sectionValidity: "current"
      }]
    }
  };
}

test("T02 accepts the Command-Center-Autostart as owner of the boot experience", () => {
  const accepted = [
    "Das gesamte Boot-Erlebnis gehört dem Command-Center-Autostart.",
    "Der Command Center-Autostart besitzt das Boot-Erlebnis."
  ];
  for (const answer of accepted) {
    const fixture = t02Fixture(answer);
    assert.equal(evaluateTruthSample(fixture.testCase, fixture).verdict, "pass", answer);
  }
});

test("T02 rejects assigning the boot experience to Jarvis or Status Companion", () => {
  const rejected = [
    "Das Boot-Erlebnis gehört zu Jarvis.",
    "Das Boot-Erlebnis ist Teil von Status Companion."
  ];
  for (const answer of rejected) {
    const fixture = t02Fixture(answer);
    const evaluated = evaluateTruthSample(fixture.testCase, fixture);
    assert.equal(evaluated.verdict, "fail", answer);
    assert.ok(evaluated.failedAssertions.includes("forbidden:boot_experience_assigned_to_wrong_product"), answer);
  }
});

test("T02 keeps requiring the server-validated DEC-012 evidence source", () => {
  const fixture = t02Fixture("Das Boot-Erlebnis gehört dem Command-Center-Autostart.", { sourceDoc: "10_Apps/90_Entscheidungen/DEC-006-Felix-Core-Vertragsebene.md" });
  const evaluated = evaluateTruthSample(fixture.testCase, fixture);
  assert.equal(evaluated.verdict, "fail");
  assert.ok(evaluated.failedAssertions.includes("cited_evidence"));
});

test("source authority metadata is recovered only from the production retrieval snapshot", () => {
  const sources = enrichCitedSources(payload().sources, retrieval().results);
  assert.equal(sources[0].informationClass, "project_context");
  const unknown = enrichCitedSources([{ sourceDoc: "invented.md", section: "X", similarity: 0.1 }], retrieval().results);
  assert.equal(unknown[0].informationClass, null);
});

test("current commit policy rejects any unqualified concrete hash, not one known hash", () => {
  assert.equal(evaluateCurrentCommitClaims("Der aktuelle HEAD ist a1b2c3d.").pass, false);
  assert.equal(evaluateCurrentCommitClaims("Der AI-Router steht aktuell auf deadbee.").pass, false);
});

test("current commit policy permits hashes clearly marked as historical snapshots", () => {
  assert.equal(evaluateCurrentCommitClaims("Die dokumentierte historische Baseline war cf0bf80; sie ist nicht der aktuelle HEAD.").pass, true);
  assert.equal(evaluateCurrentCommitClaims("Als Momentaufnahme ist deadbee belegt. Der aktuelle Commit ist nicht verifiziert.").pass, true);
  assert.equal(evaluateCurrentCommitClaims(`Der dokumentierte Stand enthält ${"a".repeat(40)} sowie die historischen Commits ${"b".repeat(40)} und ${"c".repeat(40)}; der aktuelle HEAD ist nicht belegt.`).pass, true);
});

test("an explicit current hash still fails even when another hash is historical", () => {
  assert.equal(evaluateCurrentCommitClaims("Historische Baseline: deadbee. Der aktuelle HEAD ist a1b2c3d.").pass, false);
});

test("current commit policy permits a fail-closed answer without a concrete commit", () => {
  assert.equal(evaluateCurrentCommitClaims("Der aktuelle HEAD ist aus der statischen Quelle nicht verifiziert und muss im Repository geprüft werden.").pass, true);
});

test("three of three samples are green, exactly two of three are unstable", () => {
  assert.equal(summarizeTruthCase([{ verdict: "pass" }, { verdict: "pass" }, { verdict: "pass" }]).verdict, "pass");
  assert.equal(summarizeTruthCase([{ verdict: "pass" }, { verdict: "fail" }, { verdict: "pass" }]).verdict, "unstable");
  assert.equal(summarizeTruthCase([{ verdict: "pass" }, { verdict: "fail" }, { verdict: "fail" }]).verdict, "fail");
});

test("one-sample diagnostic is pass/fail but cannot create an unstable result", () => {
  assert.equal(summarizeTruthCase([{ verdict: "pass" }]).verdict, "pass");
  assert.equal(summarizeTruthCase([{ verdict: "fail" }]).verdict, "fail");
});

test("the complete evaluation is green only when every case passes", () => {
  assert.equal(summarizeTruthEvaluation([{ summary: { verdict: "pass" } }, { summary: { verdict: "pass" } }]).green, true);
  const mixed = summarizeTruthEvaluation([{ summary: { verdict: "pass" } }, { summary: { verdict: "unstable" } }]);
  assert.equal(mixed.green, false);
  assert.equal(mixed.counts.unstable, 1);
});

function loadFrom(value, options = {}) {
  return loadTruthSet("truth.json", {
    readFileSync: () => typeof value === "string" ? value : JSON.stringify(value),
    ...options
  });
}

function validSet() {
  return {
    schemaVersion: "1.0",
    cases: [{
      id: "T01",
      question: "Was gilt?",
      expected: {
        states: ["partial"],
        knowledgeStates: ["available"],
        evidenceAnyOf: [{ sourceDoc: "a.md", informationClass: "project_context" }],
        answer: { concepts: [{ id: "fact", anyOf: ["wahr"] }], forbiddenPatterns: [] }
      }
    }]
  };
}

test("truth-set loader freezes a valid set and checks evidence against the allowlist", () => {
  const loaded = loadFrom(validSet(), { allowedDocuments: new Set(["a.md"]) });
  assert.equal(loaded.cases.length, 1);
  assert.ok(Object.isFrozen(loaded.cases[0].expected.answer));
  assert.throws(() => loadFrom(validSet(), { allowedDocuments: new Set(["other.md"]) }), /evidence_source_doc_not_allowlisted/);
});

test("truth-set loader rejects duplicate ids and invalid assertion regexes", () => {
  const duplicate = validSet();
  duplicate.cases.push(structuredClone(duplicate.cases[0]));
  assert.throws(() => loadFrom(duplicate), (error) => error instanceof RagTruthError && /case_id_duplicate/.test(error.message));
  const badRegex = validSet();
  badRegex.cases[0].expected.answer.forbiddenPatterns = [{ id: "bad", pattern: "[" }];
  assert.throws(() => loadFrom(badRegex), /forbidden_pattern_regex_invalid/);
});

test("truth-set loader rejects an invalid semantic concept regex", () => {
  const badRegex = validSet();
  badRegex.cases[0].expected.answer.concepts[0].patterns = ["["];
  assert.throws(() => loadFrom(badRegex), /answer_concept_pattern_regex_invalid/);
});

test("the committed truth set has seventeen real, contract-valid cases with split allowlist assertions", () => {
  const allowedDocuments = new Set(loadAllowlist(RAG_ALLOWLIST_FILE).documents.map((entry) => entry.relativePath));
  const loaded = loadTruthSet(undefined, { allowedDocuments });
  assert.equal(loaded.cases.length, 17);
  assert.deepEqual(loaded.cases.slice(0, 2).map((entry) => entry.id), ["T01", "T02"]);
  assert.notEqual(loaded.cases[0].question, loaded.cases[1].question);
  for (const entry of loaded.cases) {
    assert.doesNotThrow(() => normalizeKnowledgeRequest({ schemaVersion: KNOWLEDGE_SCHEMA_VERSION, question: entry.question }));
  }
});

test("T08 accepts an unknown current focus when the answer points to Tagessteuerung", () => {
  const testCase = loadTruthSet().cases.find((entry) => entry.id === "T08");
  const source = {
    sourceDoc: "10_Apps/00_Projektsteuerung.md",
    section: "Projektsteuerung > Aktuelles Fokusprojekt: zu prüfen",
    similarity: 0.8
  };
  const evaluated = evaluateTruthSample(testCase, {
    payload: {
      state: "partial",
      knowledgeState: "available",
      answer: "Der aktuelle Fokus ist unbekannt und muss bei der zuständigen Tagessteuerung geprüft werden.",
      warnings: ["current_state_not_verified"],
      sources: [source]
    },
    retrieval: {
      results: [{ ...source, informationClass: "project_context", sectionValidity: "current" }]
    }
  });
  assert.equal(evaluated.verdict, "pass");

  const alternate = evaluateTruthSample(testCase, {
    payload: {
      state: "partial",
      knowledgeState: "available",
      answer: "Der Fokusprojektstatus von heute ist unbekannt und muss bei der Tagessteuerung geprüft werden.",
      warnings: ["current_state_not_verified"],
      sources: [source]
    },
    retrieval: {
      results: [{ ...source, informationClass: "project_context", sectionValidity: "current" }]
    }
  });
  assert.equal(alternate.verdict, "pass");
});

function evaluateCommittedCase(id, answer, source) {
  const testCase = loadTruthSet().cases.find((entry) => entry.id === id);
  return evaluateTruthSample(testCase, {
    payload: {
      state: "partial",
      knowledgeState: "available",
      answer,
      warnings: [],
      sources: [source]
    },
    retrieval: {
      results: [{ ...source, informationClass: "architecture_rule", sectionValidity: "current" }]
    }
  });
}

test("T04 accepts the whole Jarvis system while still rejecting an only-contract-layer claim", () => {
  const source = {
    sourceDoc: "10_Apps/90_Entscheidungen/DEC-006-Felix-Core-Vertragsebene.md",
    section: "DEC-006 > Ergänzung Version 1.1 > Korrigierte Definition",
    similarity: 0.9
  };
  const correct = evaluateCommittedCase(
    "T04",
    "Nein, Felix Core umfasst das gesamte Jarvis-System; die Vertragsebene ist nur sein Regelteil.",
    source
  );
  assert.equal(correct.verdict, "pass");

  const wrong = evaluateCommittedCase("T04", "Felix Core ist nur die Vertragsebene.", source);
  assert.equal(wrong.verdict, "fail");
  assert.ok(wrong.failedAssertions.includes("forbidden:historical_definition_wins"));
});

test("T05 accepts a concrete alternate knowledge path but not an unspecified contract", () => {
  const source = {
    sourceDoc: "10_Apps/90_Entscheidungen/DEC-006-Felix-Core-Vertragsebene.md",
    section: "DEC-006 > Ergänzung Version 1.2 > Mehrverbraucher-Wissenszugriff",
    similarity: 0.9
  };
  const concrete = evaluateCommittedCase(
    "T05",
    "Nein. Neben dem Command Center gibt es den generischen read-only Vertrag POST /api/v1/knowledge für den Mehrverbraucher-Wissenszugriff.",
    source
  );
  assert.equal(concrete.verdict, "pass");

  const vague = evaluateCommittedCase("T05", "Nein, daneben gibt es noch einen Vertrag.", source);
  assert.equal(vague.verdict, "fail");
  assert.ok(vague.failedAssertions.includes("concept:concrete_alternative_knowledge_access"));
});
