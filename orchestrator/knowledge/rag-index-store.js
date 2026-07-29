import fs from "node:fs";
import path from "node:path";
import { RagError } from "./rag-error.js";
import {
  RAG_CHUNKS_FILE,
  RAG_INDEX_DIR,
  RAG_INDEX_META_FILE,
  RAG_INDEX_SCHEMA_VERSION,
  RAG_LOCK_FILE,
  RAG_LOCK_MAX_AGE_MS,
  RAG_MANIFEST_FILE
} from "./rag-config.js";

function ensureIndexDir() {
  fs.mkdirSync(RAG_INDEX_DIR, { recursive: true });
}

// Simple file-presence lock (mirrors the repo's own .agent-lock.json
// pattern): a stale lock older than RAG_LOCK_MAX_AGE_MS is treated as
// orphaned (e.g. a crashed process) and may be reclaimed; a fresh lock
// blocks a second concurrent index run outright.
export function acquireIndexLock() {
  ensureIndexDir();
  if (fs.existsSync(RAG_LOCK_FILE)) {
    const stats = fs.statSync(RAG_LOCK_FILE);
    if (Date.now() - stats.mtimeMs < RAG_LOCK_MAX_AGE_MS) {
      throw new RagError("INDEX_LOCKED", "Another RAG index run is already in progress.");
    }
  }
  fs.writeFileSync(RAG_LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
}

export function releaseIndexLock() {
  try {
    fs.rmSync(RAG_LOCK_FILE, { force: true });
  } catch {
    // Best-effort: an already-missing lock file is not an error.
  }
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new RagError("INDEX_CORRUPT", "Index file could not be read.", { safeDetails: { file: path.basename(filePath), reason: error?.code } });
  }
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new RagError(filePath === RAG_MANIFEST_FILE ? "MANIFEST_CORRUPT" : "INDEX_CORRUPT", "Index file is not valid JSON.", { safeDetails: { file: path.basename(filePath) } });
  }
}

export function readManifest() {
  return readJsonFile(RAG_MANIFEST_FILE, { schemaVersion: RAG_INDEX_SCHEMA_VERSION, documents: {} });
}

export function writeManifest(manifest) {
  ensureIndexDir();
  fs.writeFileSync(RAG_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

export function readIndexMeta() {
  return readJsonFile(RAG_INDEX_META_FILE, null);
}

export function writeIndexMeta(meta) {
  ensureIndexDir();
  fs.writeFileSync(RAG_INDEX_META_FILE, JSON.stringify(meta, null, 2));
}

// chunks.jsonl is rewritten wholesale from the in-memory chunk list on every
// index run. At the small document counts this feature is scoped to
// (explicit allowlist, no full-vault indexing), a full rewrite is simpler
// and safer than incremental line-patching and avoids partial-write
// corruption on a crash mid-update.
export function readAllChunks() {
  if (!fs.existsSync(RAG_CHUNKS_FILE)) return [];
  let raw;
  try {
    raw = fs.readFileSync(RAG_CHUNKS_FILE, "utf8");
  } catch (error) {
    throw new RagError("INDEX_CORRUPT", "Chunks file could not be read.", { safeDetails: { reason: error?.code } });
  }
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new RagError("INDEX_CORRUPT", "Chunks file contains an invalid line.", { safeDetails: { lineNumber: index + 1 } });
    }
  });
}

export function writeAllChunks(chunks) {
  ensureIndexDir();
  const body = chunks.map((chunk) => JSON.stringify(chunk)).join("\n");
  fs.writeFileSync(RAG_CHUNKS_FILE, body ? `${body}\n` : "");
}
