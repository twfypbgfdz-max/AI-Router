export class TextResponseError extends Error {
  constructor(code, message, { retryable = false, safeDetails = null } = {}) {
    super(message);
    this.name = "TextResponseError";
    this.code = code;
    this.retryable = retryable;
    this.safeDetails = safeDetails;
  }
}
