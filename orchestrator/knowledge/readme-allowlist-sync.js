import fs from "node:fs";
import { loadAllowlist } from "./document-allowlist.js";
import { RAG_ALLOWLIST_FILE } from "./rag-config.js";

// Keeps the "Allowlist (Stand ...)" bullet in README.md truthful without
// letting an automation silently rewrite permanent documentation (DEC-003
// section 5: automations may not overwrite existing durable documentation
// on their own). This module only computes what the block SHOULD say from
// config/rag-allowlist.json - it never touches a file. Actually writing it
// into README.md (or merely checking it) is a separate, manually-run step:
// scripts/sync-readme-allowlist.js.

export const README_BLOCK_START =
  "<!-- readme-allowlist-sync:start (auto-generated from config/rag-allowlist.json - run `npm run docs:sync-allowlist`, do not edit by hand) -->";
export const README_BLOCK_END = "<!-- readme-allowlist-sync:end -->";

const DEC_PATTERN = /^10_Apps\/90_Entscheidungen\/DEC-(\d{3,})-.+\.md$/;

function formatGermanDate(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${day}.${month}.${year}`;
}

// Groups DEC-nnn entries into a compact range when they are contiguous
// from DEC-001 (the common case), otherwise lists them individually - this
// never hides a gap, it only shortens the common "all of them" case.
function describeDocuments(documents) {
  const decNumbers = [];
  const otherPaths = [];
  for (const doc of documents) {
    const match = DEC_PATTERN.exec(doc.relativePath);
    if (match) decNumbers.push(Number.parseInt(match[1], 10));
    else otherPaths.push(doc.relativePath);
  }
  decNumbers.sort((a, b) => a - b);

  const pad = (n) => String(n).padStart(3, "0");
  const parts = [];
  if (decNumbers.length > 0) {
    const isContiguousFromOne = decNumbers[0] === 1 && decNumbers.every((n, i) => n === i + 1);
    parts.push(
      isContiguousFromOne
        ? `DEC-${pad(decNumbers[0])}–DEC-${pad(decNumbers[decNumbers.length - 1])} (vollständig, ${decNumbers.length} Dokumente)`
        : decNumbers.map((n) => `DEC-${pad(n)}`).join(", ")
    );
  }
  for (const relativePath of otherPaths) parts.push(`\`${relativePath}\``);
  return parts;
}

// Renders just the bullet text (no markers).
export function buildAllowlistBlock(documents) {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error("buildAllowlistBlock requires at least one document.");
  }
  const latestAddedAt = documents
    .map((doc) => doc.addedAt)
    .filter((value) => typeof value === "string" && value.trim())
    .sort()
    .at(-1);
  const stand = latestAddedAt ? formatGermanDate(latestAddedAt) : "unbekannt";

  const describedParts = describeDocuments(documents);
  const listText =
    describedParts.length > 1
      ? `${describedParts.slice(0, -1).join(", ")} und ${describedParts.at(-1)}`
      : describedParts[0];

  return [
    `- **Allowlist (Stand ${stand}): ${documents.length} freigegebene Dokumente.**`,
    "  `config/rag-allowlist.json` listet ausschließlich einzeln von Felix",
    `  freigegebene Dateien (\`addedBy\`/\`addedAt\` je Eintrag): ${listText}. Jede`,
    "  weitere Datei erfordert einen eigenen, ausdrücklichen Auftrag; die Liste",
    "  wächst nicht automatisch mit dem Vault. Ob alle aktuell Accepted-DEC-",
    "  Dokumente im Vault enthalten sind, prüft `npm run rag:dec-coverage`."
  ].join("\n");
}

export function renderMarkedBlock(documents) {
  return `${README_BLOCK_START}\n${buildAllowlistBlock(documents)}\n${README_BLOCK_END}`;
}

export function loadDocumentsFromAllowlist(
  allowlistFilePath = RAG_ALLOWLIST_FILE,
  { readFileSync = fs.readFileSync } = {}
) {
  return loadAllowlist(allowlistFilePath, { readFileSync }).documents;
}

function extractCurrentBlock(readmeText) {
  const startIndex = readmeText.indexOf(README_BLOCK_START);
  const endIndex = readmeText.indexOf(README_BLOCK_END);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return null;
  return {
    startIndex,
    endIndex: endIndex + README_BLOCK_END.length,
    innerText: readmeText.slice(startIndex + README_BLOCK_START.length, endIndex).trim()
  };
}

// Pure comparison, no writes. { inSync, found, expectedMarkedBlock }.
export function checkReadmeSync({ readmeText, documents }) {
  const expectedMarkedBlock = renderMarkedBlock(documents);
  const current = extractCurrentBlock(readmeText);
  if (!current) {
    return { inSync: false, found: false, expectedMarkedBlock };
  }
  return { inSync: current.innerText === buildAllowlistBlock(documents), found: true, expectedMarkedBlock };
}

// Returns the updated README text. Throws if the markers are missing -
// this never creates the markers itself, that is a one-time manual edit.
export function applySync({ readmeText, documents }) {
  const expectedMarkedBlock = renderMarkedBlock(documents);
  const current = extractCurrentBlock(readmeText);
  if (!current) {
    throw new Error(
      `Markers not found in README (expected "${README_BLOCK_START}" and "${README_BLOCK_END}").`
    );
  }
  return readmeText.slice(0, current.startIndex) + expectedMarkedBlock + readmeText.slice(current.endIndex);
}
