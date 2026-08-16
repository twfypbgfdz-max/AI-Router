const COMMIT_HASH_PATTERN = /\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/giu;
const HISTORICAL_QUALIFIER_PATTERN = /\b(?:historisch\w*|dokumentiert\w*|momentaufnahme|baseline|damals|uberholt|veraltet)\b|\bnicht (?:mehr )?(?:der )?aktuell\w*\b|\bkein\w* aktuell\w*\b|\bstand (?:vom|am)\b/iu;
const NON_CLAIM_PATTERN = /\b(?:unbekannt|nicht belegt|nicht verifiziert|nicht sicher ableitbar|nicht ermittelbar)\b/iu;
const CURRENT_COMMIT_CLAIM_PATTERN = /\b(?:aktuell\w*|derzeitig\w*|heutig\w*)\s+(?:commit|head)\b[^.!?\n]{0,40}\b(?:ist|lautet|steht auf|=)\s+[`"']?([a-z0-9._/-]{2,40})[^.!?\n]{0,80}/giu;

// Phase 5C (test-harness fix, no prompt/criteria change): NFKD + combining-
// mark removal folds every German umlaut correctly (ö/ä/ü each have a
// canonical decomposition into a base vowel plus a combining diaeresis,
// stripped by \p{M} above) - but "ß" has no NFKD decomposition to "ss" at
// all; Unicode leaves it as a single, non-decomposable code point. A truth-
// set concept written in the ASCII "ss" spelling (e.g. "ausschliesslich")
// could therefore never match a model answer using the standard German "ß"
// spelling ("ausschließlich"), independent of answer quality - confirmed by
// reproducing the exact false negative on T04 (DEC-009 Phase 5C validation,
// 16.08.2026). toLowerCase() already folds the rare capital "ẞ" to "ß", so
// a single lowercase-then-replace step normalizes both cases.
function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

function assertion(id, pass, details = null) {
  return Object.freeze({ id, pass, details });
}

function sameSource(result, source) {
  return result.sourceDoc === source.sourceDoc
    && (result.section ?? null) === (source.section ?? null)
    && Math.abs(Number(result.similarity) - Number(source.similarity)) < 1e-12;
}

export function enrichCitedSources(sources = [], retrievalResults = []) {
  return Object.freeze(sources.map((source) => {
    const result = retrievalResults.find((candidate) => sameSource(candidate, source));
    return Object.freeze({
      ...source,
      informationClass: result?.informationClass ?? null,
      sectionValidity: result?.sectionValidity ?? null
    });
  }));
}

function evidenceMatches(source, expected) {
  if (source.sourceDoc !== expected.sourceDoc) return false;
  if (expected.informationClass && source.informationClass !== expected.informationClass) return false;
  if (expected.sectionValidity && source.sectionValidity !== expected.sectionValidity) return false;
  if (expected.sectionIncludes && !normalizedText(source.section).includes(normalizedText(expected.sectionIncludes))) return false;
  return true;
}

// Every hash-like commit value is assessed by its surrounding wording. This
// intentionally does not blacklist a known historical hash: any hash is
// allowed when it is clearly labelled as a snapshot/non-current value, and
// any unqualified hash fails closed in a question asking for current HEAD.
export function evaluateCurrentCommitClaims(answer) {
  const text = normalizedText(answer);
  const violations = [];
  for (const match of text.matchAll(COMMIT_HASH_PATTERN)) {
    // A documented snapshot can list several full 40-character hashes in
    // one clause. Keep enough surrounding text for the shared historical
    // qualifier to cover that list. A contradictory explicit "current HEAD
    // is <value>" still fails independently below.
    const start = Math.max(0, match.index - 320);
    const end = Math.min(text.length, match.index + match[0].length + 320);
    const context = text.slice(start, end);
    if (!HISTORICAL_QUALIFIER_PATTERN.test(context)) violations.push(match[0]);
  }
  for (const match of text.matchAll(CURRENT_COMMIT_CLAIM_PATTERN)) {
    const claimed = match[1];
    const context = match[0];
    if (!HISTORICAL_QUALIFIER_PATTERN.test(context) && !NON_CLAIM_PATTERN.test(context) && !violations.includes(claimed)) violations.push(claimed);
  }
  return Object.freeze({ pass: violations.length === 0, violations: Object.freeze(violations) });
}

export function evaluateTruthSample(testCase, { payload, retrieval }) {
  const checks = [];
  const expected = testCase.expected;
  const answer = normalizedText(payload?.answer);
  const warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
  const sources = enrichCitedSources(payload?.sources, retrieval?.results);

  checks.push(assertion("state", expected.states.includes(payload?.state), payload?.state ?? null));
  checks.push(assertion("knowledge_state", expected.knowledgeStates.includes(payload?.knowledgeState), payload?.knowledgeState ?? null));
  for (const warning of expected.warningIncludes) checks.push(assertion(`warning_includes:${warning}`, warnings.includes(warning), warnings));
  for (const warning of expected.warningExcludes) checks.push(assertion(`warning_excludes:${warning}`, !warnings.includes(warning), warnings));
  checks.push(assertion("cited_evidence", sources.some((source) => expected.evidenceAnyOf.some((item) => evidenceMatches(source, item))), sources));

  for (const concept of expected.answer.concepts) {
    const pass = concept.anyOf.some((candidate) => answer.includes(normalizedText(candidate)))
      || concept.patterns.some((pattern) => new RegExp(pattern, "iu").test(answer));
    checks.push(assertion(`concept:${concept.id}`, pass, { anyOf: concept.anyOf, patterns: concept.patterns }));
  }
  for (const forbidden of expected.answer.forbiddenPatterns) {
    checks.push(assertion(`forbidden:${forbidden.id}`, !new RegExp(forbidden.pattern, "iu").test(answer), forbidden.pattern));
  }
  if (expected.answer.currentCommitPolicy) {
    const commitCheck = evaluateCurrentCommitClaims(payload?.answer);
    checks.push(assertion("current_commit_claim", commitCheck.pass, commitCheck.violations));
  }

  const failedAssertions = checks.filter((check) => !check.pass).map((check) => check.id);
  return Object.freeze({
    id: testCase.id,
    verdict: failedAssertions.length === 0 ? "pass" : "fail",
    failedAssertions: Object.freeze(failedAssertions),
    assertions: Object.freeze(checks),
    payload,
    citedEvidence: sources
  });
}

export function summarizeTruthCase(samples) {
  const passCount = samples.filter((sample) => sample.verdict === "pass").length;
  const sampleCount = samples.length;
  let verdict = "fail";
  if (sampleCount > 0 && passCount === sampleCount) verdict = "pass";
  else if (sampleCount === 3 && passCount === 2) verdict = "unstable";
  return Object.freeze({ sampleCount, passCount, verdict });
}

export function summarizeTruthEvaluation(cases) {
  const counts = { pass: 0, unstable: 0, fail: 0, not_evaluable: 0 };
  for (const entry of cases) counts[entry.summary?.verdict ?? "not_evaluable"] += 1;
  return Object.freeze({ total: cases.length, counts: Object.freeze(counts), green: counts.pass === cases.length });
}
