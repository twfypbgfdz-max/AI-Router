// Closed set of RAG error codes. Each error is either a hard, whole-run
// abort (structural: config/allowlist/lock/index corruption) or a
// per-document soft failure recorded in the manifest without stopping the
// rest of the run - callers distinguish the two by where the error is
// thrown from, not by a flag on this class.
export const RAG_ERROR_CODES = Object.freeze([
  "VAULT_ROOT_NOT_CONFIGURED",
  "VAULT_ROOT_UNREACHABLE",
  "ALLOWLIST_INVALID",
  "ALLOWLIST_ENTRY_DENIED",
  "ALLOWLIST_ENTRY_UNSAFE_PATH",
  "ALLOWLIST_ENTRY_DUPLICATE",
  "DOCUMENT_TOO_LARGE",
  "DOCUMENT_UNREADABLE",
  "DOCUMENT_SECRET_LIKE_CONTENT",
  "EMBEDDING_MODEL_NOT_AVAILABLE",
  "EMBEDDING_PROVIDER_UNAVAILABLE",
  "EMBEDDING_RESPONSE_INVALID",
  "EMBEDDING_TIMEOUT",
  "INDEX_LOCKED",
  "INDEX_CORRUPT",
  "MANIFEST_CORRUPT"
]);

export class RagError extends Error {
  constructor(code, message, { safeDetails = null } = {}) {
    super(message);
    this.name = "RagError";
    if (!RAG_ERROR_CODES.includes(code)) {
      throw new Error(`Unknown RagError code: ${code}`);
    }
    this.code = code;
    this.safeDetails = safeDetails;
  }
}
