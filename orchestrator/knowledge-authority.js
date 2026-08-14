import { normalizeClassificationText } from "./task-classifier.js";

// The whole authority and time model for the knowledge path, in one file.
//
// It is deliberately NOT a policy engine: there is no rule file, no
// numeric authority scale, no condition language and no interpreter. There
// are exactly three moving parts:
//
//   1. one `informationClass` string per allowlisted document
//      (config/rag-allowlist.json),
//   2. the frozen table below that says what each class may and may not
//      ground,
//   3. one boolean per question: does it demand a present state?
//
// The classes are not invented here. They implement DEC-003 section 1
// ("Informationsklassen") and section 4 ("Konfliktregeln"), which already
// bind FELIX_SYSTEM to architecture decisions, the repository/deployment
// provider to technical state, and Felix-Cockpit to operational data. This
// module only makes the retrieval path obey a decision that already exists.
//
// Two classes appear in the table without ever appearing on a document:
// `technical_state` and `operational_live`. Their primary sources
// (repository, runtime, deployment provider, Cockpit, leading sheet) are
// not wired into the knowledge path at all, and P1-A3 deliberately does not
// wire them. Naming them anyway is the point: it is what lets the answer
// path say "no source here is authoritative for that" instead of silently
// falling back to the semantically closest static snippet.

// Classes that a document may actually carry.
export const INFORMATION_CLASSES = Object.freeze([
  "architecture_rule",
  "project_context",
  "personal_reference"
]);

// Classes whose primary source the knowledge path does not have. A document
// can never be assigned one of these - they exist only as the answer to
// "who would be authoritative for this?".
export const UNAVAILABLE_PRIMARY_SOURCE_CLASSES = Object.freeze([
  "technical_state",
  "operational_live"
]);

// Fail-closed default for a missing or unrecognised class. `project_context`
// is chosen because it is the most restrictive class a document can hold:
// it is the only one that gets hedged on a present-state question. A
// misconfigured entry therefore degrades to "more careful", never to
// "more authoritative", and the document is not dropped from the index
// (dropping it would silently shrink the allowlist).
export const DEFAULT_INFORMATION_CLASS = "project_context";

// presentStateSafe answers exactly one question: may a source of this class
// ground a present-tense claim?
// - architecture_rule: yes. An Accepted decision IS the rule in force today;
//   "what applies now" is precisely what it is authoritative for.
// - personal_reference: yes. A long-term personal fact holds until changed.
// - project_context: no. It carries dated snapshots. That is exactly the
//   case P1-A3 exists for.
const AUTHORITY = Object.freeze({
  architecture_rule: Object.freeze({
    label: "Verbindliche Entscheidung",
    authoritativeFor: "Soll-Zustand, Architektur, Rollen, Zuständigkeiten und heute geltende Regeln",
    notAuthoritativeFor: "Commit, HEAD, laufende Prozesse, Deployment und die tatsächliche Implementierung",
    presentStateSafe: true
  }),
  project_context: Object.freeze({
    label: "Projektkontext",
    authoritativeFor: "Zweck, langfristigen Kontext und den dokumentierten fachlichen Stand zum genannten Datum",
    notAuthoritativeFor: "jede Aussage über heute: aktueller Commit, laufender Betrieb, Deploymentstand, heute offene Punkte und heutige Priorität",
    presentStateSafe: false
  }),
  personal_reference: Object.freeze({
    label: "Persönliche Referenz",
    authoritativeFor: "langfristige persönliche Fakten und Ziele",
    notAuthoritativeFor: "Tagesplanung, Tagespriorität und technische Zustände",
    presentStateSafe: true
  })
});

export function informationClassOf(value) {
  return INFORMATION_CLASSES.includes(value) ? value : DEFAULT_INFORMATION_CLASS;
}

export function authorityOf(informationClass) {
  return AUTHORITY[informationClassOf(informationClass)];
}

// ---------------------------------------------------------------------------
// Present-state detection
// ---------------------------------------------------------------------------
//
// A fixed pattern list over the normalised question, the same shape as the
// EXECUTION_PATTERNS this repo already trusts in provider-egress-policy.js.
// Deliberately NOT a second model call: P1-A3 must not add a classification
// model, and a local one would make every knowledge answer slower and
// non-deterministic for no gain here.
//
// The list is allowed to be blunt because its failure modes are asymmetric:
// a false positive only adds a hedging rule to the prompt (the answer gets
// more careful), a false negative leaves exactly the pre-P1-A3 behaviour.
// It can therefore never make an answer less safe than it is today.
//
// normalizeClassificationText lowercases and strips diacritics, so the
// patterns are written without umlauts ("lauft", "nachster", "prufen").
const PRESENT_STATE_PATTERNS = Object.freeze([
  /\baktuell/,
  /\bderzeit/,
  /\bmomentan/,
  /\bheute\b/,
  /\bjetzt\b/,
  /\bgerade\b/,
  /\bzur zeit\b/,
  /\bstand\b/,
  /\bcommits?\b/,
  /\blauft\b/,
  /\bdeploy(?:ed|t|ment)?\b/,
  /\boffen(?:e|en|er)?\b/,
  /\bnachste[rn]? schritt\b/
]);

export function isPresentStateQuestion(question) {
  const text = normalizeClassificationText(question);
  return PRESENT_STATE_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Soll/Ist comparison detection
// ---------------------------------------------------------------------------
//
// A distinct signal from isPresentStateQuestion, added 2026-08-14 after a
// real gap: "Entspricht die Implementierung dem?" carries no word from
// PRESENT_STATE_PATTERNS (no "aktuell", "heute", "Commit", ...), so it was
// never hedged, and the real local model answered the Soll side from a DEC
// and silently dropped the Ist side instead of naming it unverifiable.
//
// The two signals must stay separate because they trigger under different
// conditions. A present-state hedge is CONDITIONAL: it only fires when at
// least one offered source cannot carry a present-tense claim - an Accepted
// DEC alone answers "aktuell" cleanly, no hedge needed. A Soll/Ist
// comparison hedge is UNCONDITIONAL: even a perfectly authoritative DEC only
// ever proves the Soll side, so an implementation-comparison question always
// needs the Ist half named as unverifiable, regardless of how safe its
// sources are.
//
// The same asymmetric-risk argument as PRESENT_STATE_PATTERNS justified
// generous, single-verb matching at first ("a false positive only adds a
// hedge"). Pre-commit audit, 2026-08-14, showed that argument no longer
// covers three of the seven patterns once the deterministic disclaimer
// (further below) started appending visibly to `answer`: a false positive
// there no longer stays internal, it changes what the user reads. All three
// real, unrelated questions below matched before this fix -
//   "Die Beschreibung entspricht meinen Interessen - welche Interessen hat
//    Felix laut Profil?"
//   "Welche Ziele wurden laut Profil für 2026 umgesetzt?"
//   "Gibt es eine Übereinstimmung zwischen Felix' Zielen und seinen
//    Interessen?"
// - because "entspricht", "umgesetzt" and "Übereinstimmung" are common
// enough in ordinary German to occur with no relation to a Soll/Ist
// comparison at all.
//
// The other four patterns already carry their own referent word within the
// pattern itself and needed no change: "ist ... implementiert",
// "gilt ... technisch", "halt(e) ... daran" and "stimmt ... uberein" only
// ever fire together with a second, co-occurring word from the same
// sentence, so a rephrasing like "Hält sich der Code daran?" or "Stimmt die
// Umsetzung damit überein?" still matches the same way as the literal
// examples, unaffected by the fix below.
const IMPLEMENTATION_ALIGNMENT_BOUND_PATTERNS = Object.freeze([
  /\bist\b.{0,40}\bimplementiert\b/,
  /\bgilt\b.{0,30}\btechnisch\b/,
  /\bhalt\b.{0,30}\bdaran\b/,
  /\bstimmt\b.{0,30}\buberein\b/
]);

const IMPLEMENTATION_ALIGNMENT_AMBIGUOUS_PATTERNS = Object.freeze([
  /\bentspricht\b/,
  /\bumgesetzt\b/,
  /\bubereinstimmung\b/
]);

// A small, generalizable anchor class - not the three example sentences
// above hardcoded, and not restricted to only the handful of literal words
// the fix's own requirement named as examples. "implementier\w*" also
// catches "Implementierung"/"implementiert"/"implementiere",
// "technisch\w*" also catches "technische"/"technischer",
// "verbindlich\w*" also catches "verbindliche(n)", and "dec-?\d+" matches a
// concrete DEC reference (e.g. "DEC-001") without requiring the word
// "Entscheidung" to be spelled out.
const IMPLEMENTATION_CONTEXT_ANCHOR_PATTERN = /\b(?:code|implementier\w*|umsetzung|technisch\w*|repository|repo|dec-?\d+|entscheidung|soll-?zustand|verbindlich\w*)\b/;

// The bound patterns fire on their own, exactly as before. The three
// ambiguous verbs additionally require a technical/implementation-context
// anchor to co-occur anywhere in the same (short, single-line,
// contract-bounded) question - not adjacent, not ordered, just present,
// which is enough to separate "Entspricht die Implementierung dem?" from
// "Die Beschreibung entspricht meinen Interessen" without hardcoding either
// sentence.
export function isImplementationAlignmentQuestion(question) {
  const text = normalizeClassificationText(question);
  if (IMPLEMENTATION_ALIGNMENT_BOUND_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (!IMPLEMENTATION_CONTEXT_ANCHOR_PATTERN.test(text)) return false;
  return IMPLEMENTATION_ALIGNMENT_AMBIGUOUS_PATTERNS.some((pattern) => pattern.test(text));
}

// Measured 2026-08-14: IMPLEMENTATION_ALIGNMENT_NOTICE and
// IMPLEMENTATION_ALIGNMENT_RULE in knowledge-answer-prompt.js were placed
// exactly the way PRESENT_STATE_NOTICE fixed the commit-date failure - a
// salient block directly under the question, plus an explicit rule - and
// STILL did not reliably work: four separate real local-model runs of
// "...und entspricht die Implementierung dem?" all answered only the Soll
// side and never named the Ist side as unverifiable, despite both the
// notice and the rule being present in the prompt every time. Unlike the
// present-tense-claim case, prompting alone was not enough here.
//
// Given that, the requirement ("die Antwort muss ausdrücklich sagen...")
// is met deterministically instead of probabilistically: this fixed,
// server-authored sentence is appended to the answer server-side whenever
// implementationAlignmentQuestion is true, regardless of what the model
// wrote. It does not depend on parsing or judging the model's text - it is
// unconditional, exactly like the citation/action-claim checks elsewhere in
// this pipeline are server facts, not something the model is trusted to get
// right on its own. The prompt notice and rule stay in place too: they are
// harmless best-effort guidance that can still make the Soll-side half of
// the answer more precise, but they are no longer the only thing standing
// between the requirement and the model's actual output.
export const IMPLEMENTATION_ALIGNMENT_DISCLAIMER = "Ergänzender Hinweis: Ob die tatsächliche Implementierung dem oben genannten Soll-Zustand entspricht, ist aus den verfügbaren Quellen nicht sicher ableitbar. Das müsste am Repository beziehungsweise am zuständigen technischen System geprüft werden.";

// Applied only to an already fully-validated model answer (byte limit,
// action-claim, tool-call-shaped-text checks already passed on rawAnswer) -
// the appended text is server-controlled and fixed, so it needs none of
// those checks itself.
export function withImplementationAlignmentDisclaimer(answer, implementationAlignmentQuestion) {
  if (!implementationAlignmentQuestion) return answer;
  return `${answer}\n\n${IMPLEMENTATION_ALIGNMENT_DISCLAIMER}`;
}

// ---------------------------------------------------------------------------
// Historical / superseded detection
// ---------------------------------------------------------------------------
//
// FELIX_SYSTEM was truth-cleaned on 2026-08-13 so that outdated passages
// label themselves. Two places carry that label, and both are matched:
//
// - the heading path ("Historisch dokumentierte naechste Schritte vom 08.08.
//   (heute zu pruefen)" in 00_Projektsteuerung.md),
// - an explicit editorial marker at the top of the chunk body
//   ("**Historischer Wortlaut aus Version 1.0.**" in DEC-006), because
//   DEC-006's superseded sections keep neutral headings ("Ziel",
//   "7. Keine neue Komponente") and a heading-only check would miss the one
//   case that matters most: an old DEC version competing with the current
//   one.
//
// The body markers are kept narrow and editorial in shape on purpose. A
// broad match on the word "historisch" would also flag DEC-003's prose
// about keeping a history, which is current guidance, not an outdated
// passage.
const HISTORICAL_SECTION_PATTERNS = Object.freeze([
  /\bhistorisch/,
  /\bnicht aktuell\b/,
  /\bheute (?:neu )?zu prufen\b/,
  /\bkein heutiger\b/,
  /\baudit \d{2}\.\d{2}\./
]);

const HISTORICAL_BODY_PATTERNS = Object.freeze([
  /\bhistorischer wortlaut\b/,
  /\bhistorische begriffsverwendung\b/,
  /\bhistorischer zwischenstand\b/,
  /\bhistorische (?:fassung|ubergabe)\b/,
  /\bist durch version [\d.]+ supersediert\b/,
  /\bsupersediert\b/,
  /\berledigt durch version\b/
]);

// "current" | "historical" for one retrieved chunk.
export function classifyChunkValidity({ section, snippet } = {}) {
  const sectionText = normalizeClassificationText(section);
  if (section && HISTORICAL_SECTION_PATTERNS.some((pattern) => pattern.test(sectionText))) {
    return "historical";
  }
  // Only the opening of the chunk is scanned for an editorial marker: these
  // markers are always a leading blockquote in FELIX_SYSTEM, and scanning
  // the whole body would let a passing mention deep inside a current
  // section demote it.
  const bodyText = normalizeClassificationText(String(snippet || "").slice(0, 400));
  if (HISTORICAL_BODY_PATTERNS.some((pattern) => pattern.test(bodyText))) {
    return "historical";
  }
  return "current";
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export const AUTHORITY_WARNINGS = Object.freeze([
  "current_state_not_verified",
  "historical_source_only",
  "conflicting_sources"
]);

// Derived from the sources the model actually cited, never from its prose.
//
// implementationAlignmentQuestion: no informationClass is ever "safe" for
// it, so presentStateSafe is deliberately not consulted here, unlike the
// presentStateQuestion branch below. Even a source whose class IS safe for
// an ordinary "what applies now" question (architecture_rule) only proves
// the Soll side of a Soll/Ist comparison - it can never attest to whether
// the code actually implements it, because no held class is
// `technical_state`. The warning therefore fires unconditionally whenever
// the question is classified as a Soll/Ist comparison.
//
// Semantic choice (no new warning code introduced): this reuses
// current_state_not_verified rather than adding e.g.
// "no_authoritative_scope_for_technical_state". The existing code's meaning
// - "a present/current fact was requested and no held source can attest to
// it" - covers this case exactly; only the REASON differs (missing class
// vs. an unsafe class), and a client's required reaction is identical in
// both cases: treat the answer as not verified against the live system. A
// second code would duplicate that meaning without giving a caller any new
// action to take, which is exactly the "policy engine creep" P1-A3 was
// scoped to avoid.
//
// conflicting_sources is deliberately narrow: it fires when the cited
// sources contain both a current and a historical passage of the SAME
// document - a real, server-checkable contradiction (an old DEC version
// quoted alongside the current one). A broader "two classes were cited"
// rule would fire on the perfectly normal case of a decision plus a project
// note and would be noise. Detecting a genuine contradiction in prose needs
// the model, and P1-A3 deliberately does not add a model-filled metadata
// field for it.
export function deriveAuthorityWarnings({ presentStateQuestion, implementationAlignmentQuestion = false, sources = [] }) {
  const warnings = [];
  const demandsUnavailableCurrentState = Boolean(presentStateQuestion) || Boolean(implementationAlignmentQuestion);
  if (sources.length === 0) {
    if (demandsUnavailableCurrentState) warnings.push("current_state_not_verified");
    return warnings;
  }
  if (implementationAlignmentQuestion) {
    warnings.push("current_state_not_verified");
  } else if (presentStateQuestion && !sources.every((source) => authorityOf(source.informationClass).presentStateSafe)) {
    warnings.push("current_state_not_verified");
  }
  if (sources.every((source) => source.sectionValidity === "historical")) {
    warnings.push("historical_source_only");
  }
  const validityByDoc = new Map();
  for (const source of sources) {
    const seen = validityByDoc.get(source.sourceDoc) || new Set();
    seen.add(source.sectionValidity === "historical" ? "historical" : "current");
    validityByDoc.set(source.sourceDoc, seen);
  }
  for (const seen of validityByDoc.values()) {
    if (seen.size > 1) {
      warnings.push("conflicting_sources");
      break;
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Warning priority
// ---------------------------------------------------------------------------
//
// KNOWLEDGE_ANSWER_MAX_WARNINGS caps the array at 5 and the response schema
// pins maxItems to 5, so the cap is a contract value and is not raised here.
// Instead the array is ordered before truncation, so that what survives is
// always the most fundamental information:
//
//   0  rate/concurrency  - knowledgeAnswerObservationHttpStatus reads these
//                          to produce a real 429; dropping one would turn a
//                          throttled request into a silent 200.
//   1  index integrity   - the index cannot be trusted at all.
//   2  content staleness - the index no longer matches the vault bytes.
//   3  authority/time    - the answer is grounded but time-limited.
//   4  hints             - age and output-shape notes.
//
// A fundamental index state can therefore never be pushed out by an
// authority warning, which is the explicit requirement.
const WARNING_RANK = Object.freeze({
  rate_limited: 0,
  concurrency_limited: 0,

  index_incompatible: 10,
  index_error: 11,
  index_missing: 12,
  search_failed: 13,
  embedding_model_unavailable: 14,
  no_context_no_knowledge: 15,
  answer_provider_unavailable: 16,
  answer_model_unavailable: 17,
  model_response_invalid: 18,
  prompt_budget_exceeded: 19,
  internal_error: 20,
  model_source_validation_failed: 21,
  model_answer_too_large: 22,
  model_action_claim_blocked: 23,
  model_tool_call_output_blocked: 24,

  index_stale: 30,

  current_state_not_verified: 40,
  historical_source_only: 41,
  conflicting_sources: 42,

  index_age_warning: 100,
  embedding_model_identity_unverified: 101,
  model_output_contains_path_or_url: 102,
  model_output_contains_command_reference: 103
});

const UNKNOWN_WARNING_RANK = 90;

// Stable sort by rank: warnings of equal rank keep the order the caller
// produced them in, so existing single-tier behaviour is unchanged.
export function orderWarnings(warnings = []) {
  return [...new Set(warnings)]
    .map((warning, index) => ({ warning, index, rank: WARNING_RANK[warning] ?? UNKNOWN_WARNING_RANK }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map(({ warning }) => warning);
}

export const knowledgeAuthorityInternals = Object.freeze({
  AUTHORITY,
  PRESENT_STATE_PATTERNS,
  IMPLEMENTATION_ALIGNMENT_BOUND_PATTERNS,
  IMPLEMENTATION_ALIGNMENT_AMBIGUOUS_PATTERNS,
  IMPLEMENTATION_CONTEXT_ANCHOR_PATTERN,
  HISTORICAL_SECTION_PATTERNS,
  HISTORICAL_BODY_PATTERNS,
  WARNING_RANK,
  UNKNOWN_WARNING_RANK
});
