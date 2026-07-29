import { CC_KNOWLEDGE_MAX_QUESTION_CHARS, CC_KNOWLEDGE_SCHEMA_VERSION } from "./cc-knowledge-config.js";
import { CcKnowledgeError } from "./cc-knowledge-error.js";
import { normalizeCcContext, record, rejectUnknownFields, safeCompactString } from "./cc-context-fields.js";
import { providerEgressPolicyInternals } from "./provider-egress-policy.js";

const { containsSecretLikeContent, isExecutionRequest } = providerEgressPolicyInternals;

// Closed request contract: exactly {schemaVersion, question, context?}.
// - question is the only free-text field, and it goes through the same
//   bounded/single-line/no-path/no-URL/no-secret checks as every CC status
//   field (safeCompactString, reused from cc-context-fields.js), plus an
//   execution-request check that CC context fields never needed.
// - context is optional and, when present, is exactly the same closed
//   CC-status shape cc-summary uses - same field whitelist, same
//   validators, imported rather than reimplemented.
// - There is no field for RAG snippets, similarity thresholds or top-k:
//   none are defined here, so rejectUnknownFields refuses any attempt to
//   supply them. The caller cannot loosen or bypass server-side RAG limits
//   through this contract - there is no field capable of carrying them.
const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "question", "context"]);

function fail(field, reason = "invalid_field") {
  throw new CcKnowledgeError("VALIDATION_FAILED", "The knowledge request is invalid.", {
    safeDetails: { field, reason }
  });
}

function failSecurity(field, reason) {
  throw new CcKnowledgeError("SECURITY_BLOCKED", "The request cannot be processed.", {
    safeDetails: { field, reason }
  });
}

const contextErrors = Object.freeze({ fail, failSecurity });

export function normalizeCcKnowledgeRequest(value) {
  if (!record(value)) fail("request", "not_an_object");
  rejectUnknownFields(value, TOP_LEVEL_FIELDS, "request", contextErrors);
  if (value.schemaVersion !== CC_KNOWLEDGE_SCHEMA_VERSION) fail("schemaVersion", "unsupported_version");

  const question = safeCompactString(value.question, "question", CC_KNOWLEDGE_MAX_QUESTION_CHARS, contextErrors, { required: true });
  // safeCompactString already rejects control characters (including bare
  // CR/LF), so a multi-line question is already refused as
  // "control_characters" - this second check only adds the
  // execution-request pattern, which is specific to free-form questions and
  // was never needed for closed CC-status fields.
  if (isExecutionRequest(question)) {
    failSecurity("question", "execution_request_blocked");
  }
  if (containsSecretLikeContent(question)) {
    // Already covered by safeCompactString, kept as an explicit defense-in-
    // depth assertion so a future change to safeCompactString cannot
    // silently drop this guarantee for the question field specifically.
    failSecurity("question", "secret_like_content");
  }

  const context = value.context === undefined ? null : normalizeCcContext(value.context, contextErrors);

  return Object.freeze({
    schemaVersion: CC_KNOWLEDGE_SCHEMA_VERSION,
    question,
    context
  });
}
