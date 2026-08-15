import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_INFORMATION_CLASS,
  IMPLEMENTATION_ALIGNMENT_DISCLAIMER,
  INFORMATION_CLASSES,
  UNAVAILABLE_PRIMARY_SOURCE_CLASSES,
  authorityOf,
  classifyChunkValidity,
  deriveAuthorityWarnings,
  informationClassOf,
  isImplementationAlignmentQuestion,
  isPresentStateQuestion,
  orderWarnings,
  withImplementationAlignmentDisclaimer
} from "../orchestrator/knowledge-authority.js";
import { loadAllowlist } from "../orchestrator/knowledge/document-allowlist.js";
import { RAG_ALLOWLIST_FILE } from "../orchestrator/knowledge/rag-config.js";
import { buildAllowlistHash } from "../orchestrator/knowledge/rag-fingerprint.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

test("every information class a document can carry has a complete authority entry", () => {
  for (const informationClass of INFORMATION_CLASSES) {
    const authority = authorityOf(informationClass);
    assert.ok(authority.label, `${informationClass} needs a label`);
    assert.ok(authority.authoritativeFor, `${informationClass} needs an authoritative scope`);
    assert.ok(authority.notAuthoritativeFor, `${informationClass} needs an explicit non-authoritative scope`);
    assert.equal(typeof authority.presentStateSafe, "boolean");
  }
});

test("the classes whose primary source is missing are never assignable to a document", () => {
  for (const informationClass of UNAVAILABLE_PRIMARY_SOURCE_CLASSES) {
    assert.ok(!INFORMATION_CLASSES.includes(informationClass));
    assert.equal(informationClassOf(informationClass), DEFAULT_INFORMATION_CLASS);
  }
});

test("an unknown or missing class falls back to the most restrictive class, never to the most authoritative", () => {
  for (const value of [undefined, null, "", "architecture", "ARCHITECTURE_RULE", 7, {}]) {
    assert.equal(informationClassOf(value), "project_context");
  }
  assert.equal(authorityOf(undefined).presentStateSafe, false,
    "the fallback class must not be allowed to ground a present-tense claim");
});

test("only project_context is hedged on present-state questions", () => {
  assert.equal(authorityOf("architecture_rule").presentStateSafe, true);
  assert.equal(authorityOf("personal_reference").presentStateSafe, true);
  assert.equal(authorityOf("project_context").presentStateSafe, false);
});

// ---------------------------------------------------------------------------
// Present-state detection
// ---------------------------------------------------------------------------

test("questions that demand a present state are detected", () => {
  const questions = [
    "Auf welchem Commit steht der AI-Router aktuell?",
    "Was ist heute mein Fokusprojekt?",
    "Was läuft gerade?",
    "Ist das schon deployed?",
    "Was ist der Stand des AI-Routers?",
    "Welche Punkte sind derzeit offen?",
    "Was ist momentan die Priorität?",
    "Was ist jetzt zu tun?",
    "Was ist der nächste Schritt?",
    "Welche Entscheidungen sind zur Zeit offen?"
  ];
  for (const question of questions) {
    assert.equal(isPresentStateQuestion(question), true, `not detected: ${question}`);
  }
});

test("timeless knowledge questions are not treated as present-state questions", () => {
  const questions = [
    "Was ist Felix Core?",
    "Welche Rolle hat der AI-Router laut DEC-001?",
    "Welche Informationsklassen unterscheidet DEC-003?",
    "Welche Ausbildung absolviert Felix und welche Lizenzen hat er erworben?",
    "Wie ist die Arbeitsteilung zwischen den KI-Werkzeugen geregelt?",
    "Ist Felix Core nur eine Vertragsebene?"
  ];
  for (const question of questions) {
    assert.equal(isPresentStateQuestion(question), false, `false positive: ${question}`);
  }
});

test("detection is diacritic- and case-insensitive", () => {
  assert.equal(isPresentStateQuestion("WAS LÄUFT?"), true);
  assert.equal(isPresentStateQuestion("Was laeuft gerade?"), true, "matched via 'gerade'");
  assert.equal(isPresentStateQuestion("Welcher nächste Schritt steht an?"), true);
});

// ---------------------------------------------------------------------------
// Soll/Ist comparison detection
// ---------------------------------------------------------------------------

// Real regression, 2026-08-14: this exact question carries no word from
// PRESENT_STATE_PATTERNS (no "aktuell", "heute", "Commit", ...), so it was
// never hedged, and the real local model answered only the Soll side.
test("REGRESSION 2026-08-14: the real failing question is detected as a Soll/Ist comparison", () => {
  const question = "Darf der AI-Router laut Entscheidung eigenständig riskante Aktionen ausführen, und entspricht die Implementierung dem?";
  assert.equal(isImplementationAlignmentQuestion(question), true);
  assert.equal(isPresentStateQuestion(question), false, "confirms this needed its own signal, not a present-state one");
});

test("the documented example phrasings are all detected", () => {
  const questions = [
    "Entspricht die Implementierung dem?",
    "Ist das Rate-Limit im Code implementiert?",
    "Ist das im Code umgesetzt?",
    "Gilt das technisch bereits?",
    "Wie ist das implementiert?"
  ];
  for (const question of questions) {
    assert.equal(isImplementationAlignmentQuestion(question), true, `not detected: ${question}`);
  }
});

// Required generalization check: rephrasings that use neither the literal
// example strings nor obviously overlapping vocabulary must still match,
// proving the patterns catch the underlying case rather than the sample
// wording alone.
test("GENERALIZATION: rephrasings outside the example list are still detected", () => {
  assert.equal(isImplementationAlignmentQuestion("Hält sich der Code daran?"), true);
  assert.equal(isImplementationAlignmentQuestion("Stimmt die Umsetzung damit überein?"), true);
});

// ---------------------------------------------------------------------------
// Deterministic disclaimer (2026-08-14: prompting alone was measured
// unreliable - four real local-model runs all silently dropped the Ist
// side despite the prompt notice and rule being present every time)
// ---------------------------------------------------------------------------

test("the disclaimer is appended unconditionally when the question is a Soll/Ist comparison", () => {
  const result = withImplementationAlignmentDisclaimer("Laut DEC-001 nicht erlaubt.", true);
  assert.ok(result.startsWith("Laut DEC-001 nicht erlaubt."));
  assert.ok(result.includes(IMPLEMENTATION_ALIGNMENT_DISCLAIMER));
});

test("the disclaimer is never appended for an ordinary question", () => {
  assert.equal(withImplementationAlignmentDisclaimer("Laut DEC-001 nicht erlaubt.", false), "Laut DEC-001 nicht erlaubt.");
});

test("the disclaimer text itself names the missing technical source, not just 'unknown'", () => {
  assert.ok(IMPLEMENTATION_ALIGNMENT_DISCLAIMER.includes("nicht sicher ableitbar"));
  assert.ok(IMPLEMENTATION_ALIGNMENT_DISCLAIMER.includes("Repository"));
});

// ---------------------------------------------------------------------------
// False-positive audit: is "daran" / "Übereinstimmung" bound to context or
// isolated? (pre-commit verification, 2026-08-14)
// ---------------------------------------------------------------------------

// "daran" is one of the most common German pronominal adverbs and appears
// constantly in ordinary sentences with no relation to a Soll/Ist
// comparison. It is therefore deliberately bound: the pattern only matches
// when "halt"/"hält" appears within 30 characters of it, never "daran" by
// itself.
test("'daran' alone, without 'hält'/'halt' nearby, does not trigger the detection", () => {
  assert.equal(isImplementationAlignmentQuestion("Ich habe schon oft daran gedacht, mein Training umzustellen."), false);
  assert.equal(isImplementationAlignmentQuestion("Ich denke nicht daran, das zu ändern."), false);
  assert.equal(isImplementationAlignmentQuestion("Welche Ziele hat Felix, wenn er daran arbeitet, seine B-Lizenz auszubauen?"), false);
});

test("'daran' only triggers bound to 'hält'/'halt', matching the documented generalization case", () => {
  assert.equal(isImplementationAlignmentQuestion("Hält sich der Code daran?"), true);
});

// REGRESSION 2026-08-14 (pre-commit false-positive audit): "entspricht",
// "umgesetzt" and "Übereinstimmung" were originally unbound, exactly like
// this test once asserted. Once the deterministic disclaimer started
// appending visibly to `answer`, that breadth stopped being harmless - all
// three real, unrelated questions below matched before the fix. They must
// now require a technical/implementation-context anchor word to co-occur
// (see IMPLEMENTATION_CONTEXT_ANCHOR_PATTERN) and must NOT fire alone.
test("REGRESSION: 'entspricht', 'umgesetzt' and 'Übereinstimmung' no longer fire without a technical/implementation anchor", () => {
  assert.equal(isImplementationAlignmentQuestion("Es gibt eine hohe Übereinstimmung zwischen den beiden Trainingsplänen."), false);
  assert.equal(isImplementationAlignmentQuestion("Der AI-Router entspricht den Erwartungen."), false);
  assert.equal(isImplementationAlignmentQuestion("Die Maßnahmen wurden bereits umgesetzt."), false);
});

// The exact three real false-positive cases reported in the pre-commit
// audit, kept verbatim as a permanent regression guard.
test("REGRESSION: the three reported real false-positive questions no longer trigger", () => {
  assert.equal(isImplementationAlignmentQuestion("Die Beschreibung entspricht meinen Interessen - welche Interessen hat Felix laut Profil?"), false);
  assert.equal(isImplementationAlignmentQuestion("Welche Ziele wurden laut Profil für 2026 umgesetzt?"), false);
  assert.equal(isImplementationAlignmentQuestion("Gibt es eine Übereinstimmung zwischen Felix' Zielen und seinen Interessen?"), false);
});

// The same three verbs DO fire once a technical/implementation anchor word
// is present anywhere in the question - proving the fix narrows rather than
// disables detection.
test("'entspricht', 'umgesetzt' and 'Übereinstimmung' still fire with a technical anchor present", () => {
  assert.equal(isImplementationAlignmentQuestion("Entspricht die Implementierung dem?"), true);
  assert.equal(isImplementationAlignmentQuestion("Ist das im Code umgesetzt?"), true);
  assert.equal(isImplementationAlignmentQuestion("Gibt es eine Übereinstimmung zwischen der Entscheidung und dem Code?"), true);
});

// The four already-bound patterns are unaffected by the anchor requirement
// - they never needed one and still don't.
test("REGRESSION: the already-bound patterns (ist...implementiert, gilt...technisch, halt...daran, stimmt...uberein) are unaffected by the anchor fix", () => {
  assert.equal(isImplementationAlignmentQuestion("Hält sich der Code daran?"), true);
  assert.equal(isImplementationAlignmentQuestion("Stimmt die Umsetzung damit überein?"), true);
  assert.equal(isImplementationAlignmentQuestion("Wie ist das implementiert?"), true);
  assert.equal(isImplementationAlignmentQuestion("Gilt das technisch bereits?"), true);
});

test("ordinary, unrelated knowledge questions are not flagged as a Soll/Ist comparison", () => {
  const questions = [
    "Was ist Felix Core?",
    "Welche Rolle hat der AI-Router laut DEC-001?",
    "Welche Ausbildung absolviert Felix und welche Lizenzen hat er erworben?",
    "Wie ist die Arbeitsteilung zwischen den KI-Werkzeugen geregelt?",
    "Welche Informationsklassen unterscheidet DEC-003?"
  ];
  for (const question of questions) {
    assert.equal(isImplementationAlignmentQuestion(question), false, `false positive: ${question}`);
  }
});

// ---------------------------------------------------------------------------
// Historical / superseded detection
// ---------------------------------------------------------------------------

test("a heading that labels itself historical marks the chunk historical", () => {
  const sections = [
    "Projektsteuerung > Historisch dokumentierte nächste Schritte vom 08.08. (heute zu prüfen)",
    "Projektsteuerung > Zuletzt dokumentierte Projektübersicht (08.08.; heute zu prüfen)",
    "Projektsteuerung > 1. Historische App-Projekte (Audit 09.07.; nicht aktuell)",
    "Projektsteuerung > Historische Secrets-Prüfung (Audit 09.07.; kein heutiger Nachweis)",
    "Projektsteuerung > 5. Historische Risiken (Audit 09.07.; heute neu zu prüfen)",
    "Felix-Command-Center > Historische Übergabe vom 2026-08-10 und heutige Einordnung"
  ];
  for (const section of sections) {
    assert.equal(classifyChunkValidity({ section, snippet: "Irgendein Inhalt." }), "historical", section);
  }
});

// DEC-006 keeps neutral headings on its superseded Version-1.0 sections and
// carries the marker in the body instead. A heading-only check would miss
// exactly the case that matters most: an old DEC version competing with the
// current one.
test("an editorial body marker marks the chunk historical even with a neutral heading", () => {
  const historical = classifyChunkValidity({
    section: "DEC-006: Felix Core > Ziel",
    snippet: "> **Historischer Wortlaut aus Version 1.0.** \"Felix Core\" meint in diesem Abschnitt nur den damaligen Namen der Vertragsebene."
  });
  assert.equal(historical, "historical");

  const alsoHistorical = classifyChunkValidity({
    section: "DEC-006: Felix Core > 7. Keine neue Komponente",
    snippet: "> **Historische Begriffsverwendung aus Version 1.0.** Weiterhin gültig ist: ..."
  });
  assert.equal(alsoHistorical, "historical");
});

test("current content stays current", () => {
  assert.equal(classifyChunkValidity({
    section: "DEC-006: Felix Core > Ergänzung Version 1.2 (11.08.2026): Interaktionsschicht",
    snippet: "Der AI-Router erhält eine lokale Dialogoberfläche für Vault-Wissen."
  }), "current");
  assert.equal(classifyChunkValidity({ section: "Profil — Felix > Steckbrief", snippet: "Name: Felix" }), "current");
  assert.equal(classifyChunkValidity({ section: null, snippet: "Ein Absatz ohne Abschnitt." }), "current");
});

// A broad match on "historisch" would demote DEC-003's current guidance about
// keeping a history, which is exactly the false positive the narrow editorial
// markers exist to avoid.
test("prose that merely talks about keeping history is not demoted", () => {
  assert.equal(classifyChunkValidity({
    section: "DEC-003 > 3. Aktualitätsregeln > Aktualisierung",
    snippet: "Ein neuer Stand darf einen alten Stand nur durch bewusste Änderung ablösen. Der Verlauf bleibt erhalten, wenn er für Entscheidungen relevant ist."
  }), "current");
});

test("a marker deep inside a long chunk does not demote it", () => {
  const snippet = `${"Aktueller, geltender Inhalt. ".repeat(30)}Historischer Wortlaut aus Version 1.0.`;
  assert.equal(classifyChunkValidity({ section: "Irgendein Abschnitt", snippet }), "current");
});

// ---------------------------------------------------------------------------
// Warning derivation
// ---------------------------------------------------------------------------

const source = (overrides = {}) => ({
  sourceDoc: "10_Apps/01_Aktive-Projekte/AI-Router.md",
  informationClass: "project_context",
  sectionValidity: "current",
  ...overrides
});

test("a present-state question grounded only in project context is flagged unverified", () => {
  assert.deepEqual(
    deriveAuthorityWarnings({ presentStateQuestion: true, sources: [source()] }),
    ["current_state_not_verified"]
  );
});

test("a present-state question grounded only in accepted decisions is not flagged", () => {
  assert.deepEqual(
    deriveAuthorityWarnings({
      presentStateQuestion: true,
      sources: [source({ informationClass: "architecture_rule", sourceDoc: "DEC-006.md" })]
    }),
    []
  );
});

test("a personal reference answer is not blocked by the present-state safeguard", () => {
  assert.deepEqual(
    deriveAuthorityWarnings({
      presentStateQuestion: true,
      sources: [source({ informationClass: "personal_reference", sourceDoc: "90_System/Profil.md" })]
    }),
    []
  );
});

test("one non-present-state-safe source among several is enough to flag", () => {
  assert.ok(deriveAuthorityWarnings({
    presentStateQuestion: true,
    sources: [source({ informationClass: "architecture_rule", sourceDoc: "DEC-006.md" }), source()]
  }).includes("current_state_not_verified"));
});

test("a timeless question is never flagged as unverified", () => {
  assert.deepEqual(deriveAuthorityWarnings({ presentStateQuestion: false, sources: [source()] }), []);
});

// The key regression fix: even a source class that IS safe for an ordinary
// present-state question (architecture_rule) can never prove the Ist side of
// a Soll/Ist comparison, so this must warn regardless of presentStateSafe -
// unlike the plain presentStateQuestion branch tested above.
test("a Soll/Ist comparison grounded only in an accepted decision is still flagged", () => {
  assert.deepEqual(
    deriveAuthorityWarnings({
      presentStateQuestion: false,
      implementationAlignmentQuestion: true,
      sources: [source({ informationClass: "architecture_rule", sourceDoc: "DEC-001.md" })]
    }),
    ["current_state_not_verified"]
  );
});

test("a Soll/Ist comparison with no source at all is flagged", () => {
  assert.deepEqual(
    deriveAuthorityWarnings({ presentStateQuestion: false, implementationAlignmentQuestion: true, sources: [] }),
    ["current_state_not_verified"]
  );
});

test("implementationAlignmentQuestion defaults to false and does not change existing callers", () => {
  assert.deepEqual(
    deriveAuthorityWarnings({ presentStateQuestion: true, sources: [source({ informationClass: "architecture_rule" })] }),
    []
  );
});

test("a present-state question with no source at all is flagged", () => {
  assert.deepEqual(deriveAuthorityWarnings({ presentStateQuestion: true, sources: [] }), ["current_state_not_verified"]);
  assert.deepEqual(deriveAuthorityWarnings({ presentStateQuestion: false, sources: [] }), []);
});

// P6-B fix: a usable Cockpit day-context is itself authoritative for a
// present-state question, so it must not be flagged unverified just because
// RAG had no hit or an unsafe class.
test("a present-state question with no RAG source is not flagged when a Cockpit day-context is available", () => {
  assert.deepEqual(
    deriveAuthorityWarnings({ presentStateQuestion: true, sources: [], hasOperationalContext: true }),
    []
  );
});

test("a present-state question grounded only in unsafe RAG sources is not flagged when a Cockpit day-context is available", () => {
  assert.deepEqual(
    deriveAuthorityWarnings({ presentStateQuestion: true, sources: [source()], hasOperationalContext: true }),
    []
  );
});

test("hasOperationalContext defaults to false and does not change existing callers", () => {
  assert.deepEqual(deriveAuthorityWarnings({ presentStateQuestion: true, sources: [] }), ["current_state_not_verified"]);
});

// The Cockpit bypass never applies to a Soll/Ist comparison: no operational
// (daily focus/tasks/calendar) data ever attests to whether code matches a
// decision, so this warning must stay unconditional regardless of Cockpit.
test("a Soll/Ist comparison is still flagged even with a Cockpit day-context available", () => {
  assert.deepEqual(
    deriveAuthorityWarnings({
      presentStateQuestion: false,
      implementationAlignmentQuestion: true,
      sources: [],
      hasOperationalContext: true
    }),
    ["current_state_not_verified"]
  );
});

test("an answer resting only on historical passages is flagged", () => {
  assert.ok(deriveAuthorityWarnings({
    presentStateQuestion: false,
    sources: [source({ sectionValidity: "historical" }), source({ sectionValidity: "historical" })]
  }).includes("historical_source_only"));
});

test("a mix of historical and current passages is not historical-only", () => {
  assert.ok(!deriveAuthorityWarnings({
    presentStateQuestion: false,
    sources: [source({ sectionValidity: "historical" }), source({ sectionValidity: "current" })]
  }).includes("historical_source_only"));
});

// The narrow, server-checkable definition: the same document quoted in both
// a superseded and a current passage.
test("a current and a historical passage of the SAME document is a conflict", () => {
  assert.ok(deriveAuthorityWarnings({
    presentStateQuestion: false,
    sources: [
      source({ sourceDoc: "DEC-006.md", sectionValidity: "historical" }),
      source({ sourceDoc: "DEC-006.md", sectionValidity: "current" })
    ]
  }).includes("conflicting_sources"));
});

test("two different documents of different classes are not a conflict", () => {
  assert.ok(!deriveAuthorityWarnings({
    presentStateQuestion: false,
    sources: [
      source({ sourceDoc: "DEC-006.md", informationClass: "architecture_rule" }),
      source({ sourceDoc: "AI-Router.md", informationClass: "project_context" })
    ]
  }).includes("conflicting_sources"));
});

// ---------------------------------------------------------------------------
// Warning priority
// ---------------------------------------------------------------------------

test("a fundamental index state is never pushed out by authority warnings", () => {
  const ordered = orderWarnings([
    "current_state_not_verified", "historical_source_only", "conflicting_sources",
    "index_age_warning", "index_stale", "index_incompatible"
  ]);
  assert.deepEqual(ordered.slice(0, 2), ["index_incompatible", "index_stale"]);
  assert.ok(ordered.slice(0, 5).includes("index_incompatible"));
  assert.ok(ordered.slice(0, 5).includes("index_stale"));
});

test("the throttling warnings that drive the 429 always survive truncation", () => {
  const ordered = orderWarnings([
    "index_age_warning", "current_state_not_verified", "historical_source_only",
    "conflicting_sources", "index_stale", "rate_limited"
  ]);
  assert.equal(ordered[0], "rate_limited");
});

test("pure hints rank last", () => {
  const ordered = orderWarnings(["index_age_warning", "current_state_not_verified"]);
  assert.deepEqual(ordered, ["current_state_not_verified", "index_age_warning"]);
});

test("the four required tiers are ordered exactly as specified", () => {
  assert.deepEqual(
    orderWarnings(["index_age_warning", "current_state_not_verified", "index_stale", "index_error"]),
    ["index_error", "index_stale", "current_state_not_verified", "index_age_warning"]
  );
});

test("ordering deduplicates and is stable within a tier", () => {
  assert.deepEqual(
    orderWarnings(["historical_source_only", "current_state_not_verified", "historical_source_only"]),
    ["current_state_not_verified", "historical_source_only"]
  );
});

test("an unknown warning is kept but ranks below authority warnings and above pure hints", () => {
  assert.deepEqual(
    orderWarnings(["index_age_warning", "brand_new_warning", "current_state_not_verified"]),
    ["current_state_not_verified", "brand_new_warning", "index_age_warning"]
  );
});

// ---------------------------------------------------------------------------
// The real allowlist
// ---------------------------------------------------------------------------

test("every entry in the real allowlist carries a known information class", () => {
  const allowlist = loadAllowlist(RAG_ALLOWLIST_FILE);
  assert.equal(allowlist.documents.length, 10, "the reviewed allowlist holds exactly 10 documents");
  for (const entry of allowlist.documents) {
    assert.ok(INFORMATION_CLASSES.includes(entry.informationClass),
      `${entry.relativePath} has an unknown information class: ${entry.informationClass}`);
  }
});

test("the real allowlist file states an explicit class for every document, none by fallback", () => {
  const raw = JSON.parse(fs.readFileSync(RAG_ALLOWLIST_FILE, "utf8"));
  for (const entry of raw.documents) {
    assert.ok(INFORMATION_CLASSES.includes(entry.informationClass),
      `${entry.relativePath} must declare its class explicitly, not rely on the fallback`);
  }
});

test("classes are assigned as reviewed: decisions are rules, notes are context, Profil is personal", () => {
  const byPath = Object.fromEntries(loadAllowlist(RAG_ALLOWLIST_FILE).documents.map((e) => [e.relativePath, e]));
  for (const [relativePath, entry] of Object.entries(byPath)) {
    if (relativePath.includes("/90_Entscheidungen/DEC-")) {
      assert.equal(entry.informationClass, "architecture_rule", relativePath);
    }
  }
  assert.equal(byPath["90_System/Profil.md"].informationClass, "personal_reference");
  assert.equal(byPath["10_Apps/00_Projektsteuerung.md"].informationClass, "project_context");
  // Derived navigation that names itself derived must not outrank a DEC.
  assert.equal(byPath["00_System/FELIX_SYSTEM_Architektur_Index.md"].informationClass, "project_context");
});

test("reviewedAt is maintained where a review date exists and null where none does", () => {
  const byPath = Object.fromEntries(loadAllowlist(RAG_ALLOWLIST_FILE).documents.map((e) => [e.relativePath, e]));
  assert.equal(byPath["90_System/Profil.md"].reviewedAt, "2026-08-11");
  assert.equal(byPath["10_Apps/01_Aktive-Projekte/AI-Router.md"].reviewedAt, "2026-08-13");
  // No date is invented for a document that carries none.
  assert.equal(byPath["90_System/KI-Router-Regeln.md"].reviewedAt, null);
  for (const entry of Object.values(byPath)) {
    if (entry.reviewedAt !== null) assert.match(entry.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("a malformed reviewedAt becomes null instead of a guessed date", () => {
  const file = path.join(REPO_ROOT, "test", `.tmp-allowlist-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: "1.0",
    documents: [
      { relativePath: "10_Apps/a.md", informationClass: "project_context", reviewedAt: "gestern" },
      { relativePath: "10_Apps/b.md", informationClass: "project_context", reviewedAt: "2026-13-45" },
      { relativePath: "10_Apps/c.md", informationClass: "project_context" }
    ]
  }));
  try {
    for (const entry of loadAllowlist(file).documents) assert.equal(entry.reviewedAt, null);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// The whole reason no re-index is required: the authority metadata is not
// part of the allowlist identity, so editing it takes effect on the next
// request without invalidating a single embedding.
test("authority metadata is deliberately outside the allowlist fingerprint", () => {
  const withMetadata = {
    schemaVersion: "1.0",
    documents: Object.freeze([Object.freeze({
      relativePath: "10_Apps/a.md", informationClass: "architecture_rule", reviewedAt: "2026-08-13"
    })])
  };
  const withDifferentMetadata = {
    schemaVersion: "1.0",
    documents: Object.freeze([Object.freeze({
      relativePath: "10_Apps/a.md", informationClass: "personal_reference", reviewedAt: null
    })])
  };
  assert.equal(buildAllowlistHash(withMetadata), buildAllowlistHash(withDifferentMetadata),
    "changing a class or review date must not invalidate the index");
});
