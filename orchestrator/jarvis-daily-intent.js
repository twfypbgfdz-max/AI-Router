// Deterministic, keyword-based day-intent matcher for Jarvis. No model call:
// this only decides whether a question is asking about today's operative
// state (and which cockpit sections it needs), never what the answer is.
//
// Deliberately narrow. A question must contain a concrete day/task/calendar
// signal (heute, Fokus, offene Aufgaben, überfällig, Termin, ...) - generic
// words that merely sound adjacent (Ziel, Projekt, Stand, grundsätzlich) are
// not enough on their own, so "Was ist mein langfristiges Trainingsziel?"
// and "Wie steht Projekt X grundsätzlich?" never match. A small explicit
// negative guard additionally suppresses a match whenever the question
// itself signals it is asking about the long-term/general case, even if a
// day-shaped word happened to appear alongside it.

const NEGATIVE_OVERRIDE_PATTERN = /\b(langfristig(es|e|en)?|grundsätzlich|generell|allgemein|im\s+großen\s+und\s+ganzen)\b/i;

const FOCUS_PATTERN = /\b(tages)?fokus\b|\bworauf\s+(sollte\s+ich\s+mich\s+)?heute\s+(konzentrieren|fokussieren)\b/i;
// No leading \b before "überfällig": JS regex's default (non-unicode) \w
// does not include German umlauts, so \b fails to match at a boundary
// immediately before "ü" - a known JS regex gap, not a typo. The trailing
// \b after the plain-ASCII suffix (g/e/n) still works correctly.
const OVERDUE_PATTERN = /überfällig(e|en)?\b|\bverpasst(e|en)?\s+(aufgabe|termin|frist)\b/i;
const DONE_TASKS_PATTERN = /\berledigt(e|en)?\b|\babgeschlossen(e|en)?\s+aufgaben?\b|\bwas\s+habe\s+ich\s+(heute\s+)?geschafft\b/i;
// Two word orders for the same fact: "offene Aufgaben" (adjective before
// noun) and "Aufgaben ... offen" (predicative - "Aufgaben sind/stehen
// (noch) offen"), the natural phrasing of "Welche Aufgaben sind offen?".
const OPEN_TASKS_PATTERN = /\boffene(n)?\s+aufgaben\b|\baufgaben\s+(sind|stehen)\s+(noch\s+)?offen\b|\bwas\s+(muss|soll)\s+ich\s+(heute\s+)?(noch\s+)?(erledigen|tun|machen)\b|\bmeine\s+aufgaben(\s+(für\s+)?heute)?\b|\bwas\s+liegt\s+(heute\s+)?an\b/i;
const CALENDAR_PATTERN = /\btermin(e)?\b|\bkalender\b|\bmeeting(s)?\b/i;
const GENERIC_TODAY_PATTERN = /\bwas\s+steht\s+(heute\s+)?an\b|\btages(-|\s)?(überblick|stand|lage)\b|\bwie\s+sieht\s+(mein\s+)?tag\s+(heute\s+)?aus\b/i;
const BARE_TODAY_PATTERN = /\bheute\b/i;

export function matchJarvisDailyIntent(question) {
  if (typeof question !== "string" || !question.trim()) return null;
  if (NEGATIVE_OVERRIDE_PATTERN.test(question)) return null;

  const wantsFocus = FOCUS_PATTERN.test(question);
  const wantsOverdue = OVERDUE_PATTERN.test(question);
  const wantsDoneTasks = DONE_TASKS_PATTERN.test(question);
  const wantsOpenTasks = OPEN_TASKS_PATTERN.test(question);
  const wantsCalendar = CALENDAR_PATTERN.test(question);
  const wantsGenericToday = GENERIC_TODAY_PATTERN.test(question) || (BARE_TODAY_PATTERN.test(question) && !wantsFocus && !wantsOverdue && !wantsDoneTasks && !wantsOpenTasks && !wantsCalendar);

  const anySpecificSignal = wantsFocus || wantsOverdue || wantsDoneTasks || wantsOpenTasks || wantsCalendar;
  if (!anySpecificSignal && !wantsGenericToday) return null;

  // "erledigt" and "offen/überfällig" are mutually informative, not
  // exclusive - a plain "erledigt" question still wants only completed
  // tasks, while every other combination (including the bare "heute" case)
  // defaults to the pending view, which is what a day-focused answer
  // almost always means.
  const taskView = wantsDoneTasks && !wantsOpenTasks && !wantsOverdue ? "done" : "pending";

  return Object.freeze({
    needsDailyState: wantsFocus || wantsGenericToday,
    needsTasks: wantsOpenTasks || wantsDoneTasks || wantsOverdue || wantsGenericToday,
    needsCalendar: wantsCalendar || wantsGenericToday,
    taskView,
    emphasizeOverdue: wantsOverdue
  });
}

export const jarvisDailyIntentInternals = Object.freeze({
  NEGATIVE_OVERRIDE_PATTERN,
  FOCUS_PATTERN,
  OVERDUE_PATTERN,
  DONE_TASKS_PATTERN,
  OPEN_TASKS_PATTERN,
  CALENDAR_PATTERN,
  GENERIC_TODAY_PATTERN,
  BARE_TODAY_PATTERN
});
