// Its own class, not a reuse of KnowledgeError or CcReindexError: separate
// route, separate contract, must never be mistaken for either in a catch
// block - same reasoning as every other *-error.js in this repo.
export class JarvisTranscribeError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "JarvisTranscribeError";
    this.code = code;
    this.retryable = retryable;
  }
}
