// Deterministic, server-built prompt text from the already-computed,
// already-ordered ranking - the only thing handed to the shared
// text-response pipeline as input.content. Real item identities
// (alertId/serviceId/repoId/checkId/projectId) are never included here:
// Ollama only ever sees positional labels R1..Rn, exactly mirroring the
// K1..K3 pattern cc-knowledge-prompt.js already uses for citations - the
// server remains the sole authority over identity, and the model
// structurally cannot invent, guess, or leak a real ID into
// recommendedItemId because it never received one.
function itemLine(rankedItem, index) {
  return `R${index + 1}: domain=${rankedItem.domain}, priorityScore=${rankedItem.priorityScore}` +
    ` (urgency=${rankedItem.urgencyScore} x impact=${rankedItem.impactScore})`;
}

export function buildCcSnapshotPromptText(ranking) {
  const lines = ranking.items.map(itemLine);
  return [
    "The following is a deterministically pre-computed, already-ordered priority ranking of operational attention items.",
    "You did not compute this ranking, do not have access to the raw underlying data, and must never re-order, add, remove, merge, or reweight items.",
    lines.length
      ? "Exactly one ranked item is already first (R1). recommendedItemId must be exactly \"R1\" - never any other label, never null."
      : "No ranked items are listed below. recommendedItemId must be exactly null.",
    "text must summarize the listed ranking in 2-3 short sentences and briefly explain, using only the data given, why the top item (or the absence of any ranked item) is the current focus. Never invent facts, never claim a different priority than the one given.",
    "",
    ...(lines.length ? lines : ["(no ranked items)"])
  ].join("\n");
}
