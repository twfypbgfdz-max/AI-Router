// Deterministic, server-built prompt text from the already-computed,
// already-ordered ranking - the only thing handed to the shared
// text-response pipeline as input.content. Each listed item carries its
// real itemId: recommendedItemId in the contract is the real ranking-item
// ID (alertId/serviceId/repoId/checkId/projectId), not a positional label -
// a made-up placeholder like "the first item" would no longer match what
// the field is actually defined to contain, so the model must be given
// that same real ID to confirm.
function itemLine(rankedItem, position) {
  return `${position}. itemId=${rankedItem.itemId}, domain=${rankedItem.domain}, priorityScore=${rankedItem.priorityScore}` +
    ` (urgency=${rankedItem.urgencyScore} x impact=${rankedItem.impactScore})`;
}

export function buildCcSnapshotPromptText(ranking) {
  const lines = ranking.items.map((item, index) => itemLine(item, index + 1));
  const topItemId = ranking.items.length ? ranking.items[0].itemId : null;
  return [
    "The following is a deterministically pre-computed, already-ordered priority ranking of operational attention items.",
    "You did not compute this ranking, do not have access to the raw underlying data, and must never re-order, add, remove, merge, or reweight items.",
    lines.length
      ? `recommendedItemId must be exactly "${topItemId}" - the itemId of the item already ranked first (position 1) above. Never any other itemId, never an invented ID, never null.`
      : "No ranked items are listed below. recommendedItemId must be exactly null.",
    "text must summarize the listed ranking in 2-3 short sentences and briefly explain, using only the data given, why the top item (or the absence of any ranked item) is the current focus. Never invent facts, never claim a different priority than the one given.",
    "",
    ...(lines.length ? lines : ["(no ranked items)"])
  ].join("\n");
}
