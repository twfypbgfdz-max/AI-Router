import fs from "node:fs";
import crypto from "node:crypto";
import { RagError } from "./rag-error.js";
import { resolveSafeVaultPath } from "./vault-path-guard.js";
import { RAG_MAX_DOCUMENT_BYTES } from "./rag-config.js";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Minimal, deliberately narrow frontmatter reader for FELIX_SYSTEM's
// consistent "---\nkey: value\n---" format - not a general YAML parser.
// Unparsable lines are silently skipped rather than failing the whole
// document; frontmatter is metadata for display, not a security boundary.
function parseFrontmatter(rawText) {
  const match = FRONTMATTER_PATTERN.exec(rawText);
  if (!match) return { frontmatter: {}, body: rawText };
  const [, frontmatterBlock, body] = match;
  const frontmatter = {};
  for (const line of frontmatterBlock.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body };
}

function sha256(text) {
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

// Only opens the single, already-guard-validated absolute path handed in by
// the indexer - never lists or walks a directory. Read-only: this module
// contains no write/rename/unlink call on any vault path.
export function loadVaultDocument(vaultRoot, relativePath, { readFileSync = fs.readFileSync, statSync = fs.statSync } = {}) {
  const resolved = resolveSafeVaultPath(vaultRoot, relativePath);
  if (!resolved.exists) {
    return Object.freeze({ exists: false, relativePath });
  }
  const stats = statSync(resolved.absolutePath);
  if (!stats.isFile()) {
    throw new RagError("DOCUMENT_UNREADABLE", "Allowlisted path is not a regular file.", { safeDetails: { relativePath } });
  }
  if (stats.size > RAG_MAX_DOCUMENT_BYTES) {
    throw new RagError("DOCUMENT_TOO_LARGE", "Document exceeds the maximum allowed size.", { safeDetails: { relativePath, limit: RAG_MAX_DOCUMENT_BYTES } });
  }
  let rawText;
  try {
    rawText = readFileSync(resolved.absolutePath, "utf8");
  } catch (error) {
    throw new RagError("DOCUMENT_UNREADABLE", "Document could not be read.", { safeDetails: { relativePath, reason: error?.code || "read_error" } });
  }
  const { frontmatter, body } = parseFrontmatter(rawText);
  return Object.freeze({
    exists: true,
    relativePath,
    frontmatter: Object.freeze(frontmatter),
    body,
    contentHash: sha256(rawText),
    mtimeMs: stats.mtimeMs
  });
}
