import { KNOWLEDGE_MAX_QUESTION_CHARS, KNOWLEDGE_SCHEMA_VERSION } from "./knowledge-config.js";
import { KnowledgeError } from "./knowledge-error.js";
import { record, rejectUnknownFields, safeCompactString } from "./cc-context-fields.js";
import { providerEgressPolicyInternals } from "./provider-egress-policy.js";

const { containsSecretLikeContent, isExecutionRequest } = providerEgressPolicyInternals;

// Closed request contract for the generic knowledge route: exactly
// {schemaVersion, question}.
//
// The one deliberate difference to cc-knowledge-contract.js is the absence
// of `context`. The Command Center's real-time system context is its own
// data (DEC-004, section 2) and only it can produce it; a generic consumer
// has none to offer, so no field for it exists here at all. That is not a
// gap to be filled later - rejectUnknownFields actively refuses a `context`
// key, so a generic caller cannot smuggle in a hand-crafted "system state"
// and have the model treat it as authoritative fact.
//
// As in the CC contract there is no field for RAG snippets, similarity
// thresholds or top-k: none are defined, so none can be supplied, and the
// caller cannot loosen server-side RAG limits through this contract.
//
// The string validators are imported from cc-context-fields.js rather than
// reimplemented. Despite the `cc-` filename they are generic (bounded,
// single-line, no control characters, no path, no URL, no secret-like
// content); duplicating them would risk the two paths drifting apart on
// exactly the checks that must not drift.
const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "question"]);

function fail(field, reason = "invalid_field") {
  throw new KnowledgeError("VALIDATION_FAILED", "The knowledge request is invalid.", {
    safeDetails: { field, reason }
  });
}

function failSecurity(field, reason) {
  throw new KnowledgeError("SECURITY_BLOCKED", "The request cannot be processed.", {
    safeDetails: { field, reason }
  });
}

const contractErrors = Object.freeze({ fail, failSecurity });

export function normalizeKnowledgeRequest(value) {
  if (!record(value)) fail("request", "not_an_object");
  rejectUnknownFields(value, TOP_LEVEL_FIELDS, "request", contractErrors);
  if (value.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) fail("schemaVersion", "unsupported_version");

  const question = safeCompactString(value.question, "question", KNOWLEDGE_MAX_QUESTION_CHARS, contractErrors, { required: true });
  // safeCompactString already rejects control characters (including bare
  // CR/LF), so a multi-line question is refused as "control_characters" -
  // this second check only adds the execution-request pattern, which is
  // specific to free-form questions.
  if (isExecutionRequest(question)) {
    failSecurity("question", "execution_request_blocked");
  }
  if (containsSecretLikeContent(question)) {
    // Already covered by safeCompactString, kept as an explicit
    // defense-in-depth assertion so a future change there cannot silently
    // drop this guarantee for the question field specifically.
    failSecurity("question", "secret_like_content");
  }

  return Object.freeze({
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    question
  });
}
