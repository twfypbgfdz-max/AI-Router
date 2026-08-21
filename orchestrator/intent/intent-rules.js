// R2 - Intent Consolidation. Deterministic, keyword/pattern matchers for the
// three intent classes that need their own logic (action, system,
// conversation). "operational" deliberately has no new logic here - it
// reuses jarvis-daily-intent.js's matchJarvisDailyIntent() verbatim (R2
// spec §6: "jarvis-daily-intent.js nicht einfach duplizieren"). "knowledge"
// has no matcher either: it is the fallback intent-router.js returns when
// nothing else matched, exactly as it already implicitly is today.
import { matchJarvisDailyIntent } from "../jarvis-daily-intent.js";

// Action verbs: only imperative/directive requests for an outward-effecting
// operation (send, delete, create, open, execute, move, change). Kept
// narrow and German-first, matching Jarvis's real usage language.
// Broadening this vocabulary is an R4 (Action Layer) concern, not R2's -
// R2 only classifies, it never executes (see intent-router.js).
//
// Unicode-aware boundaries ((?<!\p{L}...), not \b) on purpose: JS regex's
// plain \b is defined over ASCII \w only, so it fails to match immediately
// before an umlaut ("öffne" at the start of a sentence) - the same known
// gap jarvis-daily-intent.js already documents and works around for
// "überfällig". Using \p{L}/\p{N} boundaries here avoids the same class of
// silent miss for every umlaut-initial verb (öffne, änder...), not just one.
const ACTION_VERB_PATTERN = /(?<![\p{L}\p{N}_])(schick(e|en|t)?|send(e|et|en)?|versende(n|t)?|lösch(e|en|t)?|entfern(e|en|t)?|erstell(e|en|t)?|anleg(e|en|t)?|öffne(n|t)?|starte(n|t)?|ausführen|ausgeführt|führ(e|en|t)?\s+aus|verschieb(e|en|t)?|änder(e|n|t)?|bearbeite(n|t)?)(?![\p{L}\p{N}_])/iu;

// Suppresses an action match when the question is actually asking *about*
// an action in the abstract (meaning, reasoning, rule) rather than
// requesting one to happen - R2 spec §15: "Was bedeutet mail:send?" and
// "Warum soll Jarvis keine Dateien löschen?" must stay knowledge, never
// action, even though both contain an action-shaped word.
const ACTION_META_GUARD_PATTERN = /^(was\s+bedeutet|warum|wieso|weshalb|was\s+ist|erklär(e)?)\b/i;

export function matchActionIntent(question) {
  if (typeof question !== "string" || !question.trim()) return null;
  if (ACTION_META_GUARD_PATTERN.test(question)) return null;
  if (!ACTION_VERB_PATTERN.test(question)) return null;
  // executionAvailable is always false in R2 - see R2 spec §11/§21: this
  // router only recognizes an action, a real Action Layer is out of scope.
  return Object.freeze({ executionAvailable: false });
}

// Live runtime/system state, not architecture or "how does this work"
// questions - those stay knowledge (R2 spec's own boundary example: "Wie
// funktioniert der AI-Router?" is a knowledge question). Deliberately
// verb/state-word driven rather than keyed on service nouns like
// "Router"/"Whisper" alone, which also appear constantly in ordinary
// knowledge questions about this project and would otherwise false-positive.
const SYSTEM_STATE_PATTERN = /\b(läuft|laeuft|aktiv|online|erreichbar|verfügbar|verfuegbar|gesundheit|health|status|einsatzbereit)\b/i;

export function matchSystemIntent(question) {
  if (typeof question !== "string" || !question.trim()) return null;
  if (!SYSTEM_STATE_PATTERN.test(question)) return null;
  return Object.freeze({});
}

export function matchOperationalIntent(question) {
  return matchJarvisDailyIntent(question);
}

// A follow-up that only makes sense together with prior turns (R2 spec
// §7) is recognized two ways:
//   - a fully bare interrogative/connective with nothing else ("Warum?",
//     "Und?"), or the one fixed short command from the spec's own example
//     list ("Erklär das einfacher.") - anchored, whole-question matches;
//   - a short-ish question (<= MAX_REFERENCE_WORDS words) that contains an
//     explicit anaphoric marker (an ordinal back-reference like "der
//     zweite", or davor/danach/damit) pointing at something only a prior
//     turn defines.
// Deliberately NOT bare "warum" as a prefix/substring match: a fully-formed
// standalone question that merely starts with "Warum" (e.g. "Warum soll
// Jarvis keine Dateien löschen?", R2 spec §15) must stay knowledge even
// with a session active - it does not reference anything from a prior
// turn, it just happens to share a word with the bare-interrogative case.
const BARE_REFERENCE_PATTERN = /^(warum|wieso|weshalb|und)\s*\??$/i;
const SHORT_COMMAND_PATTERN = /^(erklär|erkläre)\s+das\s+einfacher\.?\??$/i;
const REFERENCE_MARKER_PATTERN = /\b(der|die|das)\s+(zweite|erste|dritte|nächste|letzte)\w*\b|\bdavor\b|\bdanach\b|\bdamit\b/i;
const MAX_REFERENCE_WORDS = 10;

// Same shape test as matchConversationIntent below, minus the session
// gate - used by intent-router.js to tell "this looks like a reference
// question but there is no session to resolve it against" (still
// knowledge, but explicitly low-confidence, R2 spec §7's "nicht
// halluzinieren") apart from "this is an ordinary standalone question".
export function looksLikeReferenceQuestion(question) {
  if (typeof question !== "string" || !question.trim()) return false;
  const trimmed = question.trim();
  if (BARE_REFERENCE_PATTERN.test(trimmed) || SHORT_COMMAND_PATTERN.test(trimmed)) return true;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return wordCount <= MAX_REFERENCE_WORDS && REFERENCE_MARKER_PATTERN.test(trimmed);
}

export function matchConversationIntent(question, sessionContext) {
  if (!sessionContext || !Array.isArray(sessionContext.recentTurns) || sessionContext.recentTurns.length === 0) return null;
  if (!looksLikeReferenceQuestion(question)) return null;
  return Object.freeze({ usesSessionContext: true });
}

export const intentRuleInternals = Object.freeze({
  ACTION_VERB_PATTERN,
  ACTION_META_GUARD_PATTERN,
  SYSTEM_STATE_PATTERN,
  BARE_REFERENCE_PATTERN,
  SHORT_COMMAND_PATTERN,
  REFERENCE_MARKER_PATTERN
});
