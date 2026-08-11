export class CcReindexError extends Error {
  // reason, when set, must always be one of the closed RAG_ERROR_CODES
  // (see cc-reindex-response.js, which re-validates it against that same
  // list before ever placing it in a response) - never a raw message.
  constructor(code, message, { retryable = false, safeDetails = null, reason = null } = {}) {
    super(message);
    this.name = "CcReindexError";
    this.code = code;
    this.retryable = retryable;
    this.safeDetails = safeDetails;
    this.reason = reason;
  }
}
