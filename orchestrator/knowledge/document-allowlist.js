import fs from "node:fs";
import { RagError } from "./rag-error.js";
import { assertSafeRelativePath } from "./vault-path-guard.js";
import { RAG_MAX_ALLOWLIST_ENTRIES } from "./rag-config.js";
import { informationClassOf } from "../knowledge-authority.js";

const ALLOWLIST_SCHEMA_VERSION = "1.0";

// Plain calendar date, no time and no timezone: this is a review date a
// human maintains, not a machine timestamp. A malformed or absent value
// becomes null and is later rendered as "nicht datiert" - never guessed,
// never silently replaced by today.
const REVIEWED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeReviewedAt(value) {
  return typeof value === "string" && REVIEWED_AT_PATTERN.test(value.trim()) && Number.isFinite(Date.parse(value.trim()))
    ? value.trim()
    : null;
}

// Loads and validates config/rag-allowlist.json. Every entry is checked
// against the safe-path and denylist rules before it is trusted - an
// invalid or denied entry is dropped with a recorded reason, it never
// aborts the whole load (one bad line must not hide the rest of a
// reviewed list), except for structurally invalid files.
export function loadAllowlist(allowlistFilePath, { readFileSync = fs.readFileSync } = {}) {
  let raw;
  try {
    raw = readFileSync(allowlistFilePath, "utf8");
  } catch (error) {
    throw new RagError("ALLOWLIST_INVALID", "Allowlist file could not be read.", { safeDetails: { reason: error?.code || "read_error" } });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RagError("ALLOWLIST_INVALID", "Allowlist file is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RagError("ALLOWLIST_INVALID", "Allowlist file must be a JSON object.");
  }
  if (parsed.schemaVersion !== ALLOWLIST_SCHEMA_VERSION) {
    throw new RagError("ALLOWLIST_INVALID", "Unsupported allowlist schemaVersion.", { safeDetails: { schemaVersion: parsed.schemaVersion } });
  }
  if (!Array.isArray(parsed.documents)) {
    throw new RagError("ALLOWLIST_INVALID", "Allowlist documents must be an array.");
  }
  if (parsed.documents.length > RAG_MAX_ALLOWLIST_ENTRIES) {
    throw new RagError("ALLOWLIST_INVALID", "Allowlist exceeds the maximum number of entries.", { safeDetails: { limit: RAG_MAX_ALLOWLIST_ENTRIES } });
  }

  const seen = new Set();
  const accepted = [];
  const rejected = [];

  for (const entry of parsed.documents) {
    const relativePath = entry && typeof entry === "object" ? entry.relativePath : undefined;
    try {
      if (typeof relativePath !== "string") {
        throw new RagError("ALLOWLIST_ENTRY_UNSAFE_PATH", "Entry is missing relativePath.");
      }
      if (seen.has(relativePath)) {
        throw new RagError("ALLOWLIST_ENTRY_DUPLICATE", "Duplicate allowlist entry.", { safeDetails: { relativePath } });
      }
      assertSafeRelativePath(relativePath);
      seen.add(relativePath);
      // informationClass is normalized rather than validated fail-loud on
      // purpose: an unknown value falls back to the most restrictive class
      // (project_context) instead of rejecting the entry. Rejecting would
      // remove a reviewed document from the index over a typo, which is a
      // worse failure than answering that document more cautiously.
      accepted.push(Object.freeze({
        relativePath,
        addedAt: typeof entry.addedAt === "string" ? entry.addedAt : null,
        addedBy: typeof entry.addedBy === "string" ? entry.addedBy : null,
        informationClass: informationClassOf(entry.informationClass),
        reviewedAt: normalizeReviewedAt(entry.reviewedAt)
      }));
    } catch (error) {
      rejected.push(Object.freeze({ relativePath: relativePath ?? null, code: error instanceof RagError ? error.code : "ALLOWLIST_ENTRY_UNSAFE_PATH", message: error.message }));
    }
  }

  return Object.freeze({ schemaVersion: ALLOWLIST_SCHEMA_VERSION, documents: Object.freeze(accepted), rejected: Object.freeze(rejected) });
}
