import fs from "node:fs";
import path from "node:path";
import { RagError } from "./rag-error.js";
import { isDeniedPath } from "./document-denylist.js";

const RELATIVE_PATH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_\-./ ]*\.md$/;

// Rejects: absolute paths, backslashes (Windows drive/UNC forms), ".."
// traversal segments, anything outside RELATIVE_PATH_PATTERN. Pure syntax
// check - does not touch the filesystem.
export function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath) {
    throw new RagError("ALLOWLIST_ENTRY_UNSAFE_PATH", "Allowlist entry is not a string.", { safeDetails: { relativePath } });
  }
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.startsWith("\\\\")) {
    throw new RagError("ALLOWLIST_ENTRY_UNSAFE_PATH", "Allowlist entry must not be an absolute path.", { safeDetails: { relativePath } });
  }
  if (relativePath.includes("\\")) {
    throw new RagError("ALLOWLIST_ENTRY_UNSAFE_PATH", "Allowlist entry must use forward slashes.", { safeDetails: { relativePath } });
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new RagError("ALLOWLIST_ENTRY_UNSAFE_PATH", "Allowlist entry must not contain traversal segments.", { safeDetails: { relativePath } });
  }
  if (!RELATIVE_PATH_PATTERN.test(relativePath)) {
    throw new RagError("ALLOWLIST_ENTRY_UNSAFE_PATH", "Allowlist entry has an invalid shape.", { safeDetails: { relativePath } });
  }
  if (isDeniedPath(relativePath)) {
    throw new RagError("ALLOWLIST_ENTRY_DENIED", "Allowlist entry falls under a denied path prefix.", { safeDetails: { relativePath } });
  }
  return relativePath;
}

// Filesystem-level check: the real, symlink-resolved target must still be
// inside the real, symlink-resolved vault root. Catches both a directly
// malicious relative path (already rejected above) and a symlink whose
// target escapes the vault root even though the link itself looks safe.
export function resolveSafeVaultPath(vaultRoot, relativePath) {
  assertSafeRelativePath(relativePath);
  const realVaultRoot = fs.realpathSync(vaultRoot);
  const candidate = path.join(realVaultRoot, relativePath);
  let realCandidate;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, absolutePath: candidate };
    throw error;
  }
  const relativeFromRoot = path.relative(realVaultRoot, realCandidate);
  const escapesRoot = relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot);
  if (escapesRoot) {
    throw new RagError("ALLOWLIST_ENTRY_UNSAFE_PATH", "Resolved document target is outside the vault root.", { safeDetails: { relativePath } });
  }
  if (isDeniedPath(relativeFromRoot)) {
    throw new RagError("ALLOWLIST_ENTRY_DENIED", "Resolved document target falls under a denied path prefix.", { safeDetails: { relativePath } });
  }
  return { exists: true, absolutePath: realCandidate };
}
