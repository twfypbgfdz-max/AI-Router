import fs from "node:fs";
import { RagQualityError } from "./rag-quality-error.js";
import { RAG_QUALITY_MAX_CASES, RAG_QUALITY_SET_FILE } from "./rag-config.js";

const QUALITY_SET_SCHEMA_VERSION = "1.0";

// Same single-line, 500-character shape the public knowledge endpoint
// enforces (cc-knowledge-contract.js). Keeping the eval questions inside the
// exact limit the real endpoint accepts is the point: a measurement taken on
// inputs the endpoint would reject says nothing about the endpoint.
const MAX_QUESTION_CHARS = 500;

function invalid(reason, safeDetails = {}) {
  return new RagQualityError("QUALITY_SET_INVALID", `Quality set is invalid: ${reason}.`, { safeDetails: { reason, ...safeDetails } });
}

// Unlike loadAllowlist, a bad case aborts the whole load instead of being
// dropped with a recorded reason. The allowlist governs what may be read at
// runtime, where one bad line must not hide a reviewed list; this file is a
// measurement instrument, and a silently shrinking instrument would make two
// runs incomparable without saying so.
export function loadQualitySet(qualitySetFilePath = RAG_QUALITY_SET_FILE, {
  readFileSync = fs.readFileSync,
  allowedDocuments = null
} = {}) {
  let raw;
  try {
    raw = readFileSync(qualitySetFilePath, "utf8");
  } catch (error) {
    throw invalid("file_unreadable", { code: error?.code || "read_error" });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid("not_valid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("not_an_object");
  if (parsed.schemaVersion !== QUALITY_SET_SCHEMA_VERSION) throw invalid("unsupported_schema_version", { schemaVersion: parsed.schemaVersion });
  if (!Array.isArray(parsed.cases)) throw invalid("cases_not_an_array");
  if (parsed.cases.length === 0) throw invalid("cases_empty");
  if (parsed.cases.length > RAG_QUALITY_MAX_CASES) throw invalid("too_many_cases", { limit: RAG_QUALITY_MAX_CASES });

  const seenIds = new Set();
  const cases = parsed.cases.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("case_not_an_object", { index });
    const { id, question, expectedDoc } = entry;

    if (typeof id !== "string" || !id.trim()) throw invalid("case_id_missing", { index });
    if (seenIds.has(id)) throw invalid("case_id_duplicate", { id });
    seenIds.add(id);

    if (typeof question !== "string" || !question.trim()) throw invalid("question_missing", { id });
    if (question.length > MAX_QUESTION_CHARS) throw invalid("question_too_long", { id, limit: MAX_QUESTION_CHARS });
    if (/[\r\n]/.test(question)) throw invalid("question_not_single_line", { id });

    // null is the deliberate marker for a negative case, so it must be
    // spelled out - an omitted key would make "I expect no match" and "I
    // forgot to fill this in" indistinguishable.
    if (!(expectedDoc === null || (typeof expectedDoc === "string" && expectedDoc.trim()))) {
      throw invalid("expected_doc_invalid", { id });
    }
    // Catches the quiet failure mode of a question set drifting away from the
    // allowlist: a case pointing at a document that is no longer indexed can
    // never be answered, and would show up as a retrieval regression that is
    // really a stale question set.
    if (expectedDoc !== null && allowedDocuments && !allowedDocuments.has(expectedDoc)) {
      throw invalid("expected_doc_not_allowlisted", { id });
    }

    return Object.freeze({ id, question, expectedDoc, note: typeof entry.note === "string" ? entry.note : null });
  });

  return Object.freeze({ schemaVersion: QUALITY_SET_SCHEMA_VERSION, cases: Object.freeze(cases) });
}
