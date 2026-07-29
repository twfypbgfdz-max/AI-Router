import { CC_SUMMARY_REPORT_TYPES, CC_SUMMARY_SCHEMA_VERSION } from "./cc-summary-config.js";
import { CcSummaryError } from "./cc-summary-error.js";
import { normalizeCcContext, record, rejectUnknownFields } from "./cc-context-fields.js";

// Closed request contract: only compact, already-sanitized status fields.
// No input.content, no free prompt, no paths, diffs, logs or URLs - there is
// no field capable of carrying them, and every string is additionally
// bounded, single-line and checked against the same secret-pattern guard
// the shared text-response pipeline uses. The context field whitelist and
// its per-field validators live in cc-context-fields.js, shared with any
// other contract that accepts the same closed CC-status shape.
const TOP_LEVEL_FIELDS = new Set(["schemaVersion", "reportType", "context"]);

function fail(field, reason = "invalid_field") {
  throw new CcSummaryError("VALIDATION_FAILED", "The summary request is invalid.", {
    safeDetails: { field, reason }
  });
}

function failSecurity(field, reason) {
  throw new CcSummaryError("SECURITY_BLOCKED", "Secret-like content cannot be sent to the provider.", {
    safeDetails: { field, reason }
  });
}

const contextErrors = Object.freeze({ fail, failSecurity });

export function normalizeCcSummaryRequest(value) {
  if (!record(value)) fail("request", "not_an_object");
  rejectUnknownFields(value, TOP_LEVEL_FIELDS, "request", contextErrors);
  if (value.schemaVersion !== CC_SUMMARY_SCHEMA_VERSION) fail("schemaVersion", "unsupported_version");
  if (typeof value.reportType !== "string" || !CC_SUMMARY_REPORT_TYPES.includes(value.reportType)) {
    fail("reportType", "invalid_enum");
  }

  const context = normalizeCcContext(value.context, contextErrors);

  return Object.freeze({
    schemaVersion: CC_SUMMARY_SCHEMA_VERSION,
    reportType: value.reportType,
    context
  });
}
