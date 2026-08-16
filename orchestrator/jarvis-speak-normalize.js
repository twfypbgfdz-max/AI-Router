// DEC-008 (Jarvis Voice Normalization). Deterministic, model-free text
// transform applied at the speak boundary (POST /api/jarvis/speak), never at
// the knowledge path. There is still only one truth - payload.answer, built
// in knowledge-service.js - this function does not create a second,
// independently generated text; it only strips display-only artifacts from
// the exact same string before it reaches Piper.
//
// Scope is intentionally narrow, matching what the Knowledge/Operational
// prompt rules actually allow into an answer's prose (see
// knowledge-answer-prompt.js's FIXED_RULES_AFTER_CITATION and the citation
// rule): a [K#] source marker, or a relative vault path copied from a
// source's sourceDoc (see config/rag-allowlist.json's relativePath field,
// e.g. "10_Apps/90_Entscheidungen/DEC-006-Felix-Core-Vertragsebene.md").
// Nothing broader - no generic slash-path stripping, no date/number
// localization, no rewording.
//
// This module has no dependency on the request/response transport, on
// knowledge-service.js, or on any request contract - it is a pure string
// function so it can be tested and reasoned about in isolation.
//
// Caller assumption: input is expected to be answer prose from the
// Knowledge/Operational response path (the only caller today is the Jarvis
// console's "Vorlesen" button). A future second caller of
// POST /api/jarvis/speak with unrelated free text should re-check whether
// the relative-path rule below is still appropriate for that text.

// At least one "/" segment, ending in ".md" - the exact shape of
// config/rag-allowlist.json's relativePath field. Deliberately not "any
// text containing a slash": that would strip legitimate prose that happens
// to contain a "/" without also ending in ".md".
const RELATIVE_VAULT_PATH_PATTERN = /\b[\w-]+(?:\/[\w-]+)+\.md\b/g;
const SOURCE_MARKER_PATTERN = /\[K\d+\]/g;
const REPEATED_SPACE_PATTERN = /[ \t]{2,}/g;
const SPACE_BEFORE_PUNCTUATION_PATTERN = /[ \t]+([,.;:!?])/g;

export function normalizeForSpeech(text) {
  const source = String(text == null ? "" : text);
  const normalized = source
    .replace(SOURCE_MARKER_PATTERN, "")
    .replace(RELATIVE_VAULT_PATH_PATTERN, "")
    .replace(REPEATED_SPACE_PATTERN, " ")
    .replace(SPACE_BEFORE_PUNCTUATION_PATTERN, "$1")
    .trim();
  return normalized || source;
}
