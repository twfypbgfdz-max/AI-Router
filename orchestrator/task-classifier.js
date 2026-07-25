const TASK_RULES = Object.freeze([
  ["obsidian", [/\bobsidian\b/, /\bvault\b/, /\bzettelkasten\b/]],
  ["social_media", [/social[ -]?media/, /\binstagram\b/, /\blinkedin\b/, /\btiktok\b/, /\breel\b/, /\bhashtag/]],
  ["finance", [/\bfinanz/, /\bbudget/, /\baktie/, /\bsteuer/, /\bzahlung/, /\bbezahlen\b/, /\bkaufen\b/, /\bvertrag/]],
  ["career", [/\bkarriere/, /\bbewerbung/, /\blebenslauf/, /\bvorstellungsgesprach/, /\bjobs?\b/]],
  ["code", [/\bcode\b/, /\bbug\b/, /\bfehler/, /\brepositor/, /\brepo\b/, /\bgit\b/, /\bcommit/, /\bpush/, /\bdeploy/, /\bdatei/, /\bordner/, /\bjavascript\b/, /\btypescript\b/, /\bnode(?:\.js)?\b/, /\bhtml\b/, /\bcss\b/, /\bapi\b/]],
  ["research", [/\brecherch/, /\bresearch\b/, /\bquellen?\b/, /\bvergleiche?\b/, /\baktuell(?:e|en|er|es)?\b/, /\bnachschlagen/]],
  ["planning", [/\bplan(?:ung|en)?\b/, /\bkonzept/, /\bstrategie/, /\barchitektur/, /\broadmap\b/, /\bzielbild/]],
  ["everyday", [/\balltag/, /\beinkauf/, /\breise/, /\bkalender/, /\btermin/, /\be-?mail/]],
  ["learning", [/\blernen\b/, /\berklar/, /\bkurs\b/, /\bubung/, /\btutorial\b/]],
  ["writing", [/\bschreib/, /\bformulier/, /\btext\b/, /\bartikel\b/, /\buberarbeit/]]
]);

export function normalizeClassificationText(value) {
  return String(value || "")
    .toLocaleLowerCase("de-DE")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss");
}

export function classifyTask(value) {
  const text = normalizeClassificationText(value);
  return TASK_RULES.find(([, patterns]) => patterns.some((pattern) => pattern.test(text)))?.[0] || "unknown";
}
