import { TextResponseError } from "./text-response-error.js";

// Closed schemas for the structured-report intents. Adding a new report type
// means adding one entry here plus its instructions in text-response-prompt.js
// and its intent in text-response-contract.js - nothing else needs to change.
const SCHEMAS = Object.freeze({
  project_status_report: Object.freeze({
    fields: new Set(["summary", "keyFacts", "openQuestions", "risks"]),
    stringFields: ["summary"],
    stringArrayFields: ["keyFacts", "openQuestions", "risks"]
  }),
  git_change_report: Object.freeze({
    fields: new Set(["summary", "commits", "risks"]),
    stringFields: ["summary"],
    stringArrayFields: ["risks"],
    commitArrayField: "commits"
  }),
  // Commit C2a: structured knowledge-answer output. Not reachable through
  // any active route yet - registered here so the shared service already
  // validates it fail-closed, ahead of the handler/route added in C2b.
  knowledge_answer: Object.freeze({
    fields: new Set(["answer", "citedSources"]),
    stringFields: ["answer"],
    citedSourcesField: "citedSources"
  })
});

const CITED_SOURCE_ID_PATTERN = /^K[1-3]$/;
const MAX_CITED_SOURCES = 3;

function fail(reason, message = "Provider response has unexpected structure.") {
  throw new TextResponseError("PROVIDER_RESPONSE_INVALID", message, { safeDetails: { reason } });
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isValidCommitEntry(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2
    && typeof value.ref === "string" && typeof value.description === "string";
}

// Closed: only the literal strings "K1", "K2", "K3", each at most once, at
// most three entries total. No duplicate-removal or format coercion here -
// an invalid array fails the whole response fail-closed rather than being
// silently repaired, same as every other structured-report field.
function isValidCitedSourcesArray(value) {
  if (!Array.isArray(value) || value.length > MAX_CITED_SOURCES) return false;
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !CITED_SOURCE_ID_PATTERN.test(item)) return false;
    if (seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

export function isStructuredReportIntent(intent) {
  return Object.hasOwn(SCHEMAS, intent);
}

// Parses and strictly validates the provider's plain-text answer as a JSON
// object matching the closed schema for the given report intent. Throws
// TextResponseError("PROVIDER_RESPONSE_INVALID") fail-closed on any mismatch;
// returns null for intents that are not structured reports.
export function parseStructuredReport(intent, rawText) {
  const schema = SCHEMAS[intent];
  if (!schema) return null;

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    fail("structured_output_invalid", "Provider response was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("structured_output_invalid", "Provider response was not a JSON object.");
  }
  const keys = Object.keys(parsed);
  if (keys.length !== schema.fields.size || keys.some((key) => !schema.fields.has(key))) {
    fail("structured_output_invalid", "Provider response has unexpected structure.");
  }
  for (const field of schema.stringFields) {
    if (typeof parsed[field] !== "string" || !parsed[field].trim()) {
      fail("structured_output_invalid", "Provider response field is not a non-empty string.");
    }
  }
  for (const field of schema.stringArrayFields || []) {
    if (!isStringArray(parsed[field])) fail("structured_output_invalid", "Provider response field is not a string array.");
  }
  if (schema.commitArrayField) {
    const commits = parsed[schema.commitArrayField];
    if (!Array.isArray(commits) || !commits.every(isValidCommitEntry)) {
      fail("structured_output_invalid", "Provider response commits field is invalid.");
    }
  }
  if (schema.citedSourcesField) {
    if (!isValidCitedSourcesArray(parsed[schema.citedSourcesField])) {
      fail("structured_output_invalid", "Provider response citedSources field is invalid.");
    }
  }
  return Object.freeze(JSON.parse(JSON.stringify(parsed)));
}

export const structuredResponseSchemaInternals = Object.freeze({ SCHEMAS, isValidCitedSourcesArray });
