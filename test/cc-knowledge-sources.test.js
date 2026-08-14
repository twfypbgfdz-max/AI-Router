import test from "node:test";
import assert from "node:assert/strict";
import { ccKnowledgeHandlerInternals } from "../orchestrator/cc-knowledge-handler.js";
import { ragResult } from "./cc-knowledge-helpers.js";

const { validateCitedSources } = ccKnowledgeHandlerInternals;

const threeResults = [
  ragResult({ sourceDoc: "a.md", section: "A" }),
  ragResult({ sourceDoc: "b.md", section: "B" }),
  ragResult({ sourceDoc: "c.md", section: "C" })
];

test("K1 maps to results[0]", () => {
  const { ok, sources } = validateCitedSources(["K1"], threeResults, { requireAtLeastOne: false });
  assert.equal(ok, true);
  assert.equal(sources[0].sourceDoc, "a.md");
});

test("K2 and K3 map to results[1] and results[2]", () => {
  const { sources } = validateCitedSources(["K2", "K3"], threeResults, { requireAtLeastOne: false });
  assert.equal(sources[0].sourceDoc, "b.md");
  assert.equal(sources[1].sourceDoc, "c.md");
});

test("sources[] order follows citedSources order, not the original relevance rank", () => {
  const { sources } = validateCitedSources(["K3", "K1"], threeResults, { requireAtLeastOne: false });
  assert.equal(sources[0].sourceDoc, "c.md");
  assert.equal(sources[1].sourceDoc, "a.md");
});

test("an unknown source id fails closed", () => {
  const { ok, internalReason } = validateCitedSources(["K9"], threeResults, { requireAtLeastOne: false });
  assert.equal(ok, false);
  assert.equal(internalReason, "model_cited_unknown_source");
});

test("an id beyond the number of offered results fails closed", () => {
  const { ok, internalReason } = validateCitedSources(["K2"], [threeResults[0]], { requireAtLeastOne: false });
  assert.equal(ok, false);
  assert.equal(internalReason, "model_cited_unknown_source");
});

test("a non-cited result never appears in sources", () => {
  const { sources } = validateCitedSources(["K1"], threeResults, { requireAtLeastOne: false });
  assert.equal(sources.length, 1);
  assert.ok(!sources.some((s) => s.sourceDoc === "b.md" || s.sourceDoc === "c.md"));
});

test("an empty citedSources array is valid when not required (context-only answer)", () => {
  const { ok, sources } = validateCitedSources([], threeResults, { requireAtLeastOne: false });
  assert.equal(ok, true);
  assert.deepEqual(sources, []);
});

test("an empty citedSources array fails closed when at least one is required (RAG-only answer)", () => {
  const { ok, internalReason } = validateCitedSources([], threeResults, { requireAtLeastOne: true });
  assert.equal(ok, false);
  assert.equal(internalReason, "model_missing_required_source");
});

test("the model cannot manipulate sourceDoc, section, similarity, freshness, docStatus or docVersion", () => {
  // validateCitedSources takes only an id array from the model - there is no
  // parameter through which alternate metadata could be supplied, so every
  // field in the returned source always comes from the server's own
  // `results`, never from anything the model produced.
  const tampered = ["K1"];
  const { sources } = validateCitedSources(tampered, threeResults, { requireAtLeastOne: false });
  assert.deepEqual(sources[0], {
    sourceDoc: "a.md", section: "A", docStatus: "Accepted", docVersion: "1.1", similarity: 0.9, freshness: "fresh",
    // P1-A3: two further server-owned fields. They come from the same
    // `results` array as every other field and exist only so the service can
    // derive its authority warnings - closedSource() in
    // knowledge-answer-response.js rebuilds each wire source from its own
    // fixed six-field list, so neither of these ever leaves the process.
    informationClass: "architecture_rule", sectionValidity: "current"
  });
});

// The model supplies an id array and nothing else, so authority metadata is
// as unreachable for it as sourceDoc always was. Asserted explicitly because
// these two fields now steer whether an answer gets hedged.
test("the model cannot influence the authority class or the historical marking of a source", () => {
  const results = [ragResult({
    sourceDoc: "a.md", informationClass: "project_context", sectionValidity: "historical"
  })];
  const { sources } = validateCitedSources(["K1"], results, { requireAtLeastOne: true });
  assert.equal(sources[0].informationClass, "project_context");
  assert.equal(sources[0].sectionValidity, "historical");
});
