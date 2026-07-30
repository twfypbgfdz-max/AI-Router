export class CcSnapshotError extends Error {
  constructor(code, message, { retryable = false, safeDetails = null } = {}) {
    super(message);
    this.name = "CcSnapshotError";
    this.code = code;
    this.retryable = retryable;
    this.safeDetails = safeDetails;
  }
}
