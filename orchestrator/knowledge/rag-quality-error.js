// Deliberately NOT part of RAG_ERROR_CODES in rag-error.js. That set is the
// closed vocabulary the reindex endpoint may expose publicly as
// `error.reason` (see cc-reindex-response.js); widening it for a
// measurement-only tool that can never run inside a request would grow a
// public contract for no reason. Same principle the rest of this repo
// applies to schema versions: separate contracts, separate vocabularies.
export const RAG_QUALITY_ERROR_CODES = Object.freeze([
  "QUALITY_SET_INVALID",
  "QUALITY_INDEX_MISSING"
]);

export class RagQualityError extends Error {
  constructor(code, message, { safeDetails = null } = {}) {
    super(message);
    this.name = "RagQualityError";
    if (!RAG_QUALITY_ERROR_CODES.includes(code)) {
      throw new Error(`Unknown RagQualityError code: ${code}`);
    }
    this.code = code;
    this.safeDetails = safeDetails;
  }
}
