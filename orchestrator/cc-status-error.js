export class CcStatusError extends Error {
  constructor(code, message, { retryable = false, safeDetails = null } = {}) {
    super(message);
    this.name = "CcStatusError";
    this.code = code;
    this.retryable = retryable;
    this.safeDetails = safeDetails;
  }
}
