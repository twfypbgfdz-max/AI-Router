import { RAG_DENIED_PATH_PREFIXES } from "./rag-config.js";

// Folder-prefix check against the vault-relative path, independent of
// frontmatter type and independent of the allowlist - this is the last
// line of defense, checked again even for paths that already passed
// allowlist validation.
export function isDeniedPath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath) return true;
  const normalized = relativePath.replace(/\\/g, "/");
  return RAG_DENIED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export { RAG_DENIED_PATH_PREFIXES as DENIED_PATH_PREFIXES };
