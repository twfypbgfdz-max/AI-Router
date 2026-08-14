import {
  RAG_MAX_CHUNK_CHARS,
  RAG_MAX_CHUNKS_PER_DOCUMENT,
  RAG_MIN_MERGE_CHARS,
  RAG_TARGET_CHUNK_CHARS
} from "./rag-config.js";
import { RagError } from "./rag-error.js";

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;

function isFenceLine(line) {
  return /^```/.test(line.trim());
}

// Splits body text into heading-bounded sections while keeping fenced code
// blocks and (by never splitting on a line starting with "|") table rows
// intact within a section - the split only ever happens on a heading line
// outside of an open fence.
function splitIntoSections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let current = { headingPath: [], lines: [] };
  let inFence = false;

  for (const line of lines) {
    if (isFenceLine(line)) inFence = !inFence;
    const headingMatch = !inFence ? HEADING_PATTERN.exec(line) : null;
    if (headingMatch) {
      if (current.lines.some((l) => l.trim())) sections.push(current);
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      const parentPath = current.headingPath.filter((h) => h.level < level);
      current = { headingPath: [...parentPath, { level, title }], lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some((l) => l.trim())) sections.push(current);
  return sections;
}

// Splits an over-long section on blank-line paragraph boundaries so no
// chunk exceeds RAG_MAX_CHUNK_CHARS; a single paragraph longer than the
// limit is hard-cut as a last resort (never silently dropped).
function splitOversizedText(text) {
  if (text.length <= RAG_MAX_CHUNK_CHARS) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const pieces = [];
  let buffer = "";
  for (const paragraph of paragraphs) {
    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length > RAG_TARGET_CHUNK_CHARS && buffer) {
      pieces.push(buffer);
      buffer = paragraph;
    } else {
      buffer = candidate;
    }
    while (buffer.length > RAG_MAX_CHUNK_CHARS) {
      pieces.push(buffer.slice(0, RAG_MAX_CHUNK_CHARS));
      buffer = buffer.slice(RAG_MAX_CHUNK_CHARS);
    }
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}

export function chunkMarkdownBody(body, { relativePath } = {}) {
  const sections = splitIntoSections(body);
  const rawChunks = [];

  for (const section of sections) {
    const text = section.lines.join("\n").trim();
    if (!text) continue;
    const sectionPath = section.headingPath.map((h) => h.title).join(" > ") || null;
    for (const piece of splitOversizedText(text)) {
      rawChunks.push({ section: sectionPath, text: piece });
    }
  }

  // Merge very small adjacent chunks within the same section (e.g. list
  // sub-items split by an oversized-text pass) so we don't fragment into
  // many tiny, low-signal chunks.
  const merged = [];
  for (const chunk of rawChunks) {
    const previous = merged[merged.length - 1];
    if (previous && previous.section === chunk.section && previous.text.length < RAG_MIN_MERGE_CHARS && previous.text.length + chunk.text.length + 2 <= RAG_MAX_CHUNK_CHARS) {
      previous.text = `${previous.text}\n\n${chunk.text}`;
    } else {
      merged.push({ ...chunk });
    }
  }

  if (merged.length > RAG_MAX_CHUNKS_PER_DOCUMENT) {
    throw new RagError("DOCUMENT_TOO_LARGE", "Document exceeds the maximum chunk count.", {
      safeDetails: { relativePath, chunkCount: merged.length, limit: RAG_MAX_CHUNKS_PER_DOCUMENT }
    });
  }

  return merged.map((chunk, index) => Object.freeze({ ordinal: index, section: chunk.section, text: chunk.text }));
}

// Builds the text actually sent to the embedding model - never stored and
// never shown in a search snippet. Prefixing the document title and full
// section path disambiguates chunks whose original body text alone reads
// almost identically across different documents (e.g. a generic
// "Projektprofil" section repeated with similar wording in several project
// notes). Deliberately excludes the relative file path: the title alone is
// enough to identify the document once every allowlisted document has one,
// and keeps the prefix short relative to RAG_MAX_CHUNK_CHARS.
export function buildEmbeddingText(documentTitle, section, text) {
  const lines = [`Dokument: ${documentTitle}`];
  if (section) lines.push(`Abschnitt: ${section}`);
  lines.push("", text);
  return lines.join("\n");
}
