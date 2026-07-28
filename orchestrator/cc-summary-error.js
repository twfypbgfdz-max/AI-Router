export class CcSummaryError extends Error {
  constructor(code, message, { retryable = false, safeDetails = null } = {}) {
    super(message);
    this.name = "CcSummaryError";
    this.code = code;
    this.retryable = retryable;
    this.safeDetails = safeDetails;
  }
}
