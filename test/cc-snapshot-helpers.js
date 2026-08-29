export const TEST_CC_TOKEN = "test-cc-snapshot-service-token-0123456789abcdef";
export const TEST_INTERNAL_TOKEN = "test-internal-service-token-0123456789abcdef";
export const MODEL = "qwen2.5:7b-instruct";

export function ccSnapshotEnv(overrides = {}) {
  return {
    AI_ROUTER_CC_TOKEN: TEST_CC_TOKEN,
    AI_ROUTER_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    AI_ROUTER_OLLAMA_MODEL: MODEL,
    AI_ROUTER_OLLAMA_EMBEDDING_MODEL: "bge-m3:latest",
    AI_ROUTER_OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    ...overrides
  };
}

const NOW_ISO = "2026-07-30T12:00:00.000Z";

export function evidenceAt(status = "available", timestamp = NOW_ISO) {
  return { status, timestamp };
}

export function emptySection(overrides = {}) {
  return { evidence: evidenceAt(), freshness: "fresh", items: [], ...overrides };
}

export function validSnapshotBody(overrides = {}) {
  return {
    schemaVersion: "1.0",
    sections: {
      alerts: emptySection(),
      services: emptySection(),
      gitRepositories: emptySection(),
      failedChecks: emptySection(),
      projectProgress: emptySection()
    },
    ...overrides
  };
}

// One item per domain, each already evidenced and actionable, so the
// deterministic ranking always produces a non-empty result:
// - alerts: critical, single-project -> urgency 3 x impact 1 = 3
// - services: down, cross-project -> 3 x 2 = 6 (this becomes the top item)
// - gitRepositories: conflict, single-project -> 3 x 1 = 3
// - failedChecks: severity unknown, single-project -> 1 x 1 = 1
// - projectProgress: blocked, single-project -> 3 x 1 = 3
export function fullSnapshotBody(overrides = {}) {
  return validSnapshotBody({
    sections: {
      alerts: {
        evidence: evidenceAt(),
        freshness: "fresh",
        items: [{ alertId: "alert-1", code: "disk_space_low", severity: "critical", impactScope: "single-project", evidence: evidenceAt() }]
      },
      services: {
        evidence: evidenceAt(),
        freshness: "fresh",
        items: [{ serviceId: "svc-router", status: "down", impactScope: "cross-project", evidence: evidenceAt() }]
      },
      gitRepositories: {
        evidence: evidenceAt(),
        freshness: "fresh",
        items: [{ repoId: "ai-router", branch: "dev", status: "conflict", impactScope: "single-project", evidence: evidenceAt() }]
      },
      failedChecks: {
        evidence: evidenceAt(),
        freshness: "fresh",
        items: [{ checkId: "check-1", projectId: "ai-router", kind: "test", severity: "unknown", impactScope: "single-project", evidence: evidenceAt() }]
      },
      projectProgress: {
        evidence: evidenceAt(),
        freshness: "fresh",
        items: [{ projectId: "ai-router", projectName: "AI-Router", progressStatus: "blocked", nextStepSummary: "Fix the merge conflict.", impactScope: "single-project", evidence: evidenceAt() }]
      }
    },
    ...overrides
  });
}

export function ragHit(overrides = {}) {
  return {
    sourceDoc: "10_Apps/90_Entscheidungen/DEC-001.md",
    section: "3.3 AI-Router",
    docStatus: "Accepted",
    docVersion: "1.1",
    similarity: 0.9,
    freshness: "fresh",
    ...overrides
  };
}

// A structured snapshot_briefing adapter: text + recommendedItemId, both
// JSON-stringified exactly as the shared pipeline expects for a structured
// intent. `recommendedItemId` defaults to "svc-router" (the real itemId of
// fullSnapshotBody()'s top-ranked item - services, priorityScore 6, see
// cc-snapshot-ranking.test.js); tests that need to simulate a
// model-disagrees-with-the-ranking case pass a different, non-matching value.
export function structuredSnapshotAdapter({ text = "Der Service-Ausfall hat die höchste Priorität.", recommendedItemId = "svc-router" } = {}) {
  const calls = [];
  return {
    adapter: {
      async generateText(input) {
        calls.push(input);
        return {
          text: JSON.stringify({ text, recommendedItemId }),
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
          truncated: false
        };
      }
    },
    calls
  };
}
