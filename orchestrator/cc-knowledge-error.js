export class CcKnowledgeError extends Error {
  constructor(code, message, { retryable = false, safeDetails = null } = {}) {
    super(message);
    this.name = "CcKnowledgeError";
    this.code = code;
    this.retryable = retryable;
    this.safeDetails = safeDetails;
  }
}
