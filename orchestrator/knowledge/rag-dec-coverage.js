import fs from "node:fs";
import path from "node:path";
import { loadAllowlist } from "./document-allowlist.js";
import { RAG_ALLOWLIST_FILE } from "./rag-config.js";

// Read-only DEC coverage check (F1-2): which Accepted architecture decisions
// under FELIX_SYSTEM/10_Apps/90_Entscheidungen are missing from
// config/rag-allowlist.json. This never writes to the allowlist or the
// vault - it only reports a gap, the same "observe, never auto-fix"
// discipline the rest of the knowledge path already follows (DEC-001
// section 2, point 7: no automatic write-back into FELIX_SYSTEM).
export const DEC_DIRECTORY_RELATIVE = "10_Apps/90_Entscheidungen";

// Matches "DEC-001-Some-Title.md" but not "Entscheidungslog.md" or a future
// non-DEC file dropped into the same folder - those are silently ignored,
// not treated as missing DECs ("unerwartete Dateien" must not fail the
// check).
const DEC_FILENAME_PATTERN = /^DEC-\d{3,}-.+\.md$/;

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;

// Only "Accepted" counts as a decision Jarvis is required to know. A DEC
// with any other status (Draft, Superseded, Withdrawn, Rejected, ...) is
// deliberately not required to be allowlisted - this is what keeps a
// superseded or not-yet-final decision from failing the coverage check.
const REQUIRED_STATUS = "Accepted";

function readFrontmatterStatus(absolutePath, readFileSync) {
  let raw;
  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch {
    return null;
  }
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) return null;
  for (const line of match[1].split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (key !== "status") continue;
    return line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

// Lists the Accepted DEC documents' vault-relative paths, sorted for a
// deterministic result independent of directory read order.
function listAcceptedDecRelativePaths(vaultRoot, { readdirSync, readFileSync }) {
  const decDirectoryAbsolute = path.join(vaultRoot, ...DEC_DIRECTORY_RELATIVE.split("/"));
  const entries = readdirSync(decDirectoryAbsolute);
  const acceptedRelativePaths = [];
  for (const entry of entries) {
    if (!DEC_FILENAME_PATTERN.test(entry)) continue;
    const absolutePath = path.join(decDirectoryAbsolute, entry);
    if (readFrontmatterStatus(absolutePath, readFileSync) !== REQUIRED_STATUS) continue;
    acceptedRelativePaths.push(`${DEC_DIRECTORY_RELATIVE}/${entry}`);
  }
  acceptedRelativePaths.sort();
  return acceptedRelativePaths;
}

// { totalValid, totalAllowlisted, missing, pass, validRelativePaths }.
// `missing` lists Accepted DECs not present in the allowlist; `pass` is
// true only when nothing is missing. Deliberately does not report
// allowlist entries that no longer correspond to an Accepted DEC (a
// withdrawn decision staying allowlisted is a separate, non-blocking
// concern from "is a current decision reachable").
export function computeDecCoverage({
  vaultRoot,
  allowlistFilePath = RAG_ALLOWLIST_FILE,
  readdirSync = fs.readdirSync,
  readFileSync = fs.readFileSync,
  loadAllowlistFn = loadAllowlist
} = {}) {
  if (typeof vaultRoot !== "string" || !vaultRoot.trim()) {
    throw new Error("computeDecCoverage requires a non-empty vaultRoot.");
  }

  const validRelativePaths = listAcceptedDecRelativePaths(vaultRoot, { readdirSync, readFileSync });
  const allowlist = loadAllowlistFn(allowlistFilePath, { readFileSync });
  const allowlistedPaths = new Set(allowlist.documents.map((document) => document.relativePath));

  const missing = validRelativePaths.filter((relativePath) => !allowlistedPaths.has(relativePath));
  const totalAllowlisted = validRelativePaths.length - missing.length;

  return Object.freeze({
    totalValid: validRelativePaths.length,
    totalAllowlisted,
    missing: Object.freeze(missing),
    pass: missing.length === 0,
    validRelativePaths: Object.freeze(validRelativePaths)
  });
}
