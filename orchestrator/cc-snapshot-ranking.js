import {
  CC_SNAPSHOT_DOMAIN_ORDER,
  CC_SNAPSHOT_ID_FIELD,
  CC_SNAPSHOT_URGENCY_FIELD,
  CC_SNAPSHOT_URGENCY_MAP,
  CC_SNAPSHOT_IMPACT_MAP,
  CC_SNAPSHOT_MAX_RANKED_ITEMS
} from "./cc-snapshot-config.js";

// Pure, deterministic priorityScore = urgency x impact (Abschnitt 5 des
// genehmigten Vertrags). No randomness, no clock, no I/O - same input always
// produces the same ordered output. Ollama never sees the raw sections and
// never influences this calculation.
function urgencyFor(domain, item) {
  const field = CC_SNAPSHOT_URGENCY_FIELD[domain];
  const table = CC_SNAPSHOT_URGENCY_MAP[domain];
  const score = table[item[field]];
  return score === undefined || score === null ? null : score;
}

function impactFor(item) {
  return CC_SNAPSHOT_IMPACT_MAP[item.impactScope] ?? CC_SNAPSHOT_IMPACT_MAP.unknown;
}

function domainRankIndex() {
  return Object.fromEntries(CC_SNAPSHOT_DOMAIN_ORDER.map((domain, index) => [domain, index]));
}

export function rankSnapshot(normalizedInput) {
  const ranked = [];
  const unranked = [];

  for (const domain of CC_SNAPSHOT_DOMAIN_ORDER) {
    const idField = CC_SNAPSHOT_ID_FIELD[domain];
    for (const item of normalizedInput.sections[domain].items) {
      const id = item[idField];
      if (item.evidence.status !== "available") {
        unranked.push(Object.freeze({ itemId: id, domain, reasonCode: "evidence_unavailable" }));
        continue;
      }
      const urgencyScore = urgencyFor(domain, item);
      if (urgencyScore === null) {
        unranked.push(Object.freeze({ itemId: id, domain, reasonCode: "status_not_actionable" }));
        continue;
      }
      const impactScore = impactFor(item);
      ranked.push({
        itemId: id,
        domain,
        urgencyScore,
        impactScore,
        priorityScore: urgencyScore * impactScore,
        evidenceTimestamp: item.evidence.timestamp
      });
    }
  }

  const domainRank = domainRankIndex();
  ranked.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    if (domainRank[a.domain] !== domainRank[b.domain]) return domainRank[a.domain] - domainRank[b.domain];
    return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
  });

  return Object.freeze({
    items: Object.freeze(ranked.slice(0, CC_SNAPSHOT_MAX_RANKED_ITEMS).map(Object.freeze)),
    unranked: Object.freeze(unranked)
  });
}
