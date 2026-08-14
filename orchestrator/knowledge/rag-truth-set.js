import fs from "node:fs";
import { KNOWLEDGE_MAX_QUESTION_CHARS } from "../knowledge-config.js";
import { RAG_TRUTH_MAX_CASES, RAG_TRUTH_SET_FILE } from "./rag-config.js";
import { RagTruthError } from "./rag-truth-error.js";

const TRUTH_SET_SCHEMA_VERSION = "1.0";
const VALID_STATES = new Set(["ok", "partial", "unavailable"]);
const VALID_KNOWLEDGE_STATES = new Set([
  "available", "no_match", "index_stale", "index_missing",
  "embedding_model_unavailable", "search_failed"
]);
const VALID_INFORMATION_CLASSES = new Set(["architecture_rule", "project_context", "personal_reference"]);
const VALID_SECTION_VALIDITIES = new Set(["current", "historical", "unknown"]);
const CURRENT_COMMIT_POLICY = "no_verified_current_commit_without_live_source";

function invalid(reason, safeDetails = {}) {
  throw new RagTruthError("TRUTH_SET_INVALID", `Truth set is invalid: ${reason}.`, {
    safeDetails: { reason, ...safeDetails }
  });
}

function stringArray(value, field, id, { allowed = null, allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) invalid(`${field}_invalid`, { id });
  const normalized = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) invalid(`${field}_invalid`, { id });
    if (allowed && !allowed.has(entry)) invalid(`${field}_invalid`, { id, value: entry });
    return entry;
  });
  return Object.freeze(normalized);
}

function parseEvidence(value, id, allowedDocuments) {
  if (!Array.isArray(value) || value.length === 0) invalid("evidence_any_of_invalid", { id });
  return Object.freeze(value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid("evidence_invalid", { id });
    if (typeof entry.sourceDoc !== "string" || !entry.sourceDoc.trim()) invalid("evidence_source_doc_invalid", { id });
    if (allowedDocuments && !allowedDocuments.has(entry.sourceDoc)) invalid("evidence_source_doc_not_allowlisted", { id, sourceDoc: entry.sourceDoc });
    if (entry.informationClass !== undefined && !VALID_INFORMATION_CLASSES.has(entry.informationClass)) {
      invalid("evidence_information_class_invalid", { id });
    }
    if (entry.sectionValidity !== undefined && !VALID_SECTION_VALIDITIES.has(entry.sectionValidity)) {
      invalid("evidence_section_validity_invalid", { id });
    }
    if (entry.sectionIncludes !== undefined && (typeof entry.sectionIncludes !== "string" || !entry.sectionIncludes.trim())) {
      invalid("evidence_section_includes_invalid", { id });
    }
    return Object.freeze({
      sourceDoc: entry.sourceDoc,
      informationClass: entry.informationClass ?? null,
      sectionValidity: entry.sectionValidity ?? null,
      sectionIncludes: entry.sectionIncludes ?? null
    });
  }));
}

function parseAnswer(value, id) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("answer_invalid", { id });
  if (!Array.isArray(value.concepts)) invalid("answer_concepts_invalid", { id });
  const seenConcepts = new Set();
  const concepts = Object.freeze(value.concepts.map((concept) => {
    if (!concept || typeof concept !== "object" || Array.isArray(concept)) invalid("answer_concept_invalid", { id });
    if (typeof concept.id !== "string" || !concept.id.trim() || seenConcepts.has(concept.id)) invalid("answer_concept_id_invalid", { id });
    seenConcepts.add(concept.id);
    const anyOf = stringArray(concept.anyOf ?? [], "answer_concept_any_of", id);
    const patterns = stringArray(concept.patterns ?? [], "answer_concept_patterns", id);
    if (anyOf.length === 0 && patterns.length === 0) invalid("answer_concept_matcher_missing", { id, conceptId: concept.id });
    for (const pattern of patterns) {
      try { new RegExp(pattern, "iu"); } catch { invalid("answer_concept_pattern_regex_invalid", { id, conceptId: concept.id }); }
    }
    return Object.freeze({ id: concept.id, anyOf, patterns });
  }));
  const forbiddenPatterns = Object.freeze((value.forbiddenPatterns ?? []).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid("forbidden_pattern_invalid", { id });
    if (typeof entry.id !== "string" || !entry.id.trim() || typeof entry.pattern !== "string" || !entry.pattern.trim()) {
      invalid("forbidden_pattern_invalid", { id });
    }
    try { new RegExp(entry.pattern, "iu"); } catch { invalid("forbidden_pattern_regex_invalid", { id, patternId: entry.id }); }
    return Object.freeze({ id: entry.id, pattern: entry.pattern });
  }));
  const currentCommitPolicy = value.currentCommitPolicy ?? null;
  if (currentCommitPolicy !== null && currentCommitPolicy !== CURRENT_COMMIT_POLICY) {
    invalid("current_commit_policy_invalid", { id });
  }
  return Object.freeze({ concepts, forbiddenPatterns, currentCommitPolicy });
}

export function loadTruthSet(truthSetFilePath = RAG_TRUTH_SET_FILE, {
  readFileSync = fs.readFileSync,
  allowedDocuments = null
} = {}) {
  let raw;
  try { raw = readFileSync(truthSetFilePath, "utf8"); }
  catch (error) { invalid("file_unreadable", { code: error?.code || "read_error" }); }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { invalid("not_valid_json"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("not_an_object");
  if (parsed.schemaVersion !== TRUTH_SET_SCHEMA_VERSION) invalid("unsupported_schema_version", { schemaVersion: parsed.schemaVersion });
  if (!Array.isArray(parsed.cases)) invalid("cases_not_an_array");
  if (parsed.cases.length === 0) invalid("cases_empty");
  if (parsed.cases.length > RAG_TRUTH_MAX_CASES) invalid("too_many_cases", { limit: RAG_TRUTH_MAX_CASES });

  const seenIds = new Set();
  const cases = parsed.cases.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid("case_not_an_object", { index });
    const { id, question, expected } = entry;
    if (typeof id !== "string" || !id.trim()) invalid("case_id_missing", { index });
    if (seenIds.has(id)) invalid("case_id_duplicate", { id });
    seenIds.add(id);
    if (typeof question !== "string" || !question.trim()) invalid("question_missing", { id });
    if (question.length > KNOWLEDGE_MAX_QUESTION_CHARS) invalid("question_too_long", { id });
    if (/[\r\n]/.test(question)) invalid("question_not_single_line", { id });
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) invalid("expected_invalid", { id });

    return Object.freeze({
      id,
      question,
      note: typeof entry.note === "string" ? entry.note : null,
      expected: Object.freeze({
        states: stringArray(expected.states, "states", id, { allowed: VALID_STATES, allowEmpty: false }),
        knowledgeStates: stringArray(expected.knowledgeStates, "knowledge_states", id, { allowed: VALID_KNOWLEDGE_STATES, allowEmpty: false }),
        warningIncludes: stringArray(expected.warningIncludes ?? [], "warning_includes", id),
        warningExcludes: stringArray(expected.warningExcludes ?? [], "warning_excludes", id),
        evidenceAnyOf: parseEvidence(expected.evidenceAnyOf, id, allowedDocuments),
        answer: parseAnswer(expected.answer, id)
      })
    });
  });

  return Object.freeze({ schemaVersion: TRUTH_SET_SCHEMA_VERSION, cases: Object.freeze(cases) });
}

export const ragTruthSetInternals = Object.freeze({ CURRENT_COMMIT_POLICY });
