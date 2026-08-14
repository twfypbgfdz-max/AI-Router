export const RAG_TRUTH_ERROR_CODES = Object.freeze([
  "TRUTH_SET_INVALID",
  "TRUTH_INDEX_NOT_CURRENT"
]);

export class RagTruthError extends Error {
  constructor(code, message, { safeDetails = null } = {}) {
    super(message);
    this.name = "RagTruthError";
    if (!RAG_TRUTH_ERROR_CODES.includes(code)) {
      throw new Error(`Unknown RagTruthError code: ${code}`);
    }
    this.code = code;
    this.safeDetails = safeDetails;
  }
}
