import test from "node:test";
import assert from "node:assert/strict";
import { rankSnapshot } from "../orchestrator/cc-snapshot-ranking.js";
import { normalizeCcSnapshotRequest } from "../orchestrator/cc-snapshot-contract.js";
import { fullSnapshotBody, evidenceAt } from "./cc-snapshot-helpers.js";

const NOW = () => new Date("2026-07-30T12:00:00.000Z");

function normalize(body) {
  return normalizeCcSnapshotRequest(body, { now: NOW });
}

test("priorityScore = urgency x impact, sorted descending", () => {
  const ranking = rankSnapshot(normalize(fullSnapshotBody()));
  // services (down=3 x cross-project=2 = 6) must rank first.
  assert.equal(ranking.items[0].domain, "services");
  assert.equal(ranking.items[0].priorityScore, 6);
  for (let i = 1; i < ranking.items.length; i += 1) {
    assert.ok(ranking.items[i - 1].priorityScore >= ranking.items[i].priorityScore);
  }
});

test("ranking is fully deterministic across repeated runs on the same input", () => {
  const input = normalize(fullSnapshotBody());
  const first = rankSnapshot(input);
  const second = rankSnapshot(input);
  const third = rankSnapshot(input);
  assert.deepEqual(first.items.map((i) => i.itemId), second.items.map((i) => i.itemId));
  assert.deepEqual(first.items.map((i) => i.itemId), third.items.map((i) => i.itemId));
  assert.deepEqual(first.items, second.items);
});

test("tie-break: equal priorityScore is ordered by fixed domain order, then itemId", () => {
  const body = fullSnapshotBody({
    sections: {
      alerts: { evidence: evidenceAt(), freshness: "fresh", items: [
        { alertId: "a-z", code: "x", severity: "warning", impactScope: "single-project", evidence: evidenceAt() }
      ] },
      services: { evidence: evidenceAt(), freshness: "fresh", items: [
        { serviceId: "s-a", status: "degraded", impactScope: "single-project", evidence: evidenceAt() }
      ] },
      gitRepositories: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      failedChecks: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      projectProgress: { evidence: evidenceAt(), freshness: "fresh", items: [] }
    }
  });
  // Both score 2 x 1 = 2. Fixed domain order: alerts before services.
  const ranking = rankSnapshot(normalize(body));
  assert.deepEqual(ranking.items.map((i) => i.domain), ["alerts", "services"]);
});

test("tie-break: same domain, same score, ordered by itemId lexicographically", () => {
  const body = fullSnapshotBody({
    sections: {
      alerts: { evidence: evidenceAt(), freshness: "fresh", items: [
        { alertId: "b-alert", code: "x", severity: "warning", impactScope: "single-project", evidence: evidenceAt() },
        { alertId: "a-alert", code: "y", severity: "warning", impactScope: "single-project", evidence: evidenceAt() }
      ] },
      services: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      gitRepositories: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      failedChecks: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      projectProgress: { evidence: evidenceAt(), freshness: "fresh", items: [] }
    }
  });
  const ranking = rankSnapshot(normalize(body));
  assert.deepEqual(ranking.items.map((i) => i.itemId), ["a-alert", "b-alert"]);
});

test("evidence.status !== available is excluded from ranking with reasonCode evidence_unavailable", () => {
  const body = fullSnapshotBody({
    sections: {
      alerts: { evidence: evidenceAt(), freshness: "fresh", items: [
        { alertId: "no-evidence", code: "x", severity: "critical", impactScope: "single-project", evidence: { status: "unavailable", timestamp: null } }
      ] },
      services: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      gitRepositories: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      failedChecks: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      projectProgress: { evidence: evidenceAt(), freshness: "fresh", items: [] }
    }
  });
  const ranking = rankSnapshot(normalize(body));
  assert.equal(ranking.items.length, 0);
  assert.deepEqual(ranking.unranked, [{ itemId: "no-evidence", domain: "alerts", reasonCode: "evidence_unavailable" }]);
});

test("a non-actionable status (e.g. alerts unknown, services ok, git clean) is excluded, not scored as 0", () => {
  const body = fullSnapshotBody({
    sections: {
      alerts: { evidence: evidenceAt(), freshness: "fresh", items: [
        { alertId: "unknown-alert", code: "x", severity: "unknown", impactScope: "single-project", evidence: evidenceAt() }
      ] },
      services: { evidence: evidenceAt(), freshness: "fresh", items: [
        { serviceId: "healthy-service", status: "ok", impactScope: "single-project", evidence: evidenceAt() }
      ] },
      gitRepositories: { evidence: evidenceAt(), freshness: "fresh", items: [
        { repoId: "clean-repo", status: "clean", impactScope: "single-project", evidence: evidenceAt() }
      ] },
      failedChecks: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      projectProgress: { evidence: evidenceAt(), freshness: "fresh", items: [
        { projectId: "on-track-project", projectName: "P", progressStatus: "on-track", impactScope: "single-project", evidence: evidenceAt() }
      ] }
    }
  });
  const ranking = rankSnapshot(normalize(body));
  assert.equal(ranking.items.length, 0);
  const reasonCodes = ranking.unranked.map((u) => u.reasonCode);
  assert.ok(reasonCodes.every((code) => code === "status_not_actionable"));
  assert.equal(ranking.unranked.length, 4);
});

// --- The approved, deliberate asymmetry for failedChecks.severity --------

test("failedChecks.severity 'unknown' IS scored (same as non-blocking=1), unlike unknown/unavailable status in every other domain", () => {
  const body = fullSnapshotBody({
    sections: {
      alerts: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      services: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      gitRepositories: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      failedChecks: { evidence: evidenceAt(), freshness: "fresh", items: [
        { checkId: "unknown-severity-check", kind: "test", severity: "unknown", impactScope: "single-project", evidence: evidenceAt() },
        { checkId: "non-blocking-check", kind: "test", severity: "non-blocking", impactScope: "single-project", evidence: evidenceAt() }
      ] },
      projectProgress: { evidence: evidenceAt(), freshness: "fresh", items: [] }
    }
  });
  const ranking = rankSnapshot(normalize(body));
  assert.equal(ranking.unranked.length, 0, "an unknown-severity failed check must never land in unranked");
  assert.equal(ranking.items.length, 2);
  const unknownItem = ranking.items.find((i) => i.itemId === "unknown-severity-check");
  const nonBlockingItem = ranking.items.find((i) => i.itemId === "non-blocking-check");
  assert.equal(unknownItem.urgencyScore, 1);
  assert.equal(unknownItem.urgencyScore, nonBlockingItem.urgencyScore, "unknown must score exactly like non-blocking");
});

test("a missing/omitted failedChecks.severity field also normalizes to the scored 'unknown', not excluded", () => {
  const body = fullSnapshotBody({
    sections: {
      alerts: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      services: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      gitRepositories: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      failedChecks: { evidence: evidenceAt(), freshness: "fresh", items: [
        { checkId: "severity-omitted-check", kind: "test", impactScope: "single-project", evidence: evidenceAt() }
      ] },
      projectProgress: { evidence: evidenceAt(), freshness: "fresh", items: [] }
    }
  });
  const ranking = rankSnapshot(normalize(body));
  assert.equal(ranking.unranked.length, 0);
  assert.equal(ranking.items.length, 1);
  assert.equal(ranking.items[0].urgencyScore, 1);
});

test("failedChecks.severity 'blocking' outranks 'unknown'", () => {
  const body = fullSnapshotBody({
    sections: {
      alerts: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      services: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      gitRepositories: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      failedChecks: { evidence: evidenceAt(), freshness: "fresh", items: [
        { checkId: "unknown-severity", kind: "test", severity: "unknown", impactScope: "single-project", evidence: evidenceAt() },
        { checkId: "blocking-severity", kind: "test", severity: "blocking", impactScope: "single-project", evidence: evidenceAt() }
      ] },
      projectProgress: { evidence: evidenceAt(), freshness: "fresh", items: [] }
    }
  });
  const ranking = rankSnapshot(normalize(body));
  assert.equal(ranking.items[0].itemId, "blocking-severity");
  assert.equal(ranking.items[1].itemId, "unknown-severity");
});

test("impactScope 'unknown' defaults to weight 1, the same as single-project", () => {
  const body = fullSnapshotBody({
    sections: {
      alerts: { evidence: evidenceAt(), freshness: "fresh", items: [
        { alertId: "impact-unknown", code: "x", severity: "critical", impactScope: "unknown", evidence: evidenceAt() },
        { alertId: "impact-single", code: "y", severity: "critical", impactScope: "single-project", evidence: evidenceAt() }
      ] },
      services: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      gitRepositories: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      failedChecks: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      projectProgress: { evidence: evidenceAt(), freshness: "fresh", items: [] }
    }
  });
  const ranking = rankSnapshot(normalize(body));
  const unknownImpact = ranking.items.find((i) => i.itemId === "impact-unknown");
  const singleImpact = ranking.items.find((i) => i.itemId === "impact-single");
  assert.equal(unknownImpact.impactScore, 1);
  assert.equal(unknownImpact.priorityScore, singleImpact.priorityScore);
});

test("ranked items are capped at CC_SNAPSHOT_MAX_RANKED_ITEMS (10)", () => {
  const items = Array.from({ length: 15 }, (_, i) => ({
    alertId: `alert-${String(i).padStart(2, "0")}`,
    code: "x",
    severity: "critical",
    impactScope: "single-project",
    evidence: evidenceAt()
  }));
  const body = fullSnapshotBody({
    sections: {
      alerts: { evidence: evidenceAt(), freshness: "fresh", items },
      services: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      gitRepositories: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      failedChecks: { evidence: evidenceAt(), freshness: "fresh", items: [] },
      projectProgress: { evidence: evidenceAt(), freshness: "fresh", items: [] }
    }
  });
  const ranking = rankSnapshot(normalize(body));
  assert.equal(ranking.items.length, 10);
  assert.equal(ranking.unranked.length, 0, "items beyond the top 10 are still actionable, just not part of ranking.items - not unranked/excluded");
});
