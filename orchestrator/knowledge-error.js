// Deliberately its own class rather than a reuse of CcKnowledgeError: the
// generic knowledge route and the Command Center route are separate
// contracts, and an error raised by one must never be mistaken for the
// other's in a catch block. The shape is identical on purpose - both feed
// the same closed transport-failure builder, which reads only `code`.
export class KnowledgeError extends Error {
  constructor(code, message, { retryable = false, safeDetails = null } = {}) {
    super(message);
    this.name = "KnowledgeError";
    this.code = code;
    this.retryable = retryable;
    this.safeDetails = safeDetails;
  }
}
