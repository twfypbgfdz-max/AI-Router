// Its own class, not a reuse of JarvisTranscribeError or any other *-error
// class in this repo - separate route, separate contract, must never be
// mistaken for another's in a catch block.
export class JarvisSpeakError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "JarvisSpeakError";
    this.code = code;
    this.retryable = retryable;
  }
}
