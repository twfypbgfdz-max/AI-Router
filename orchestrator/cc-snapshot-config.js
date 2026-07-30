import { TEXT_RESPONSE_RATE_WINDOW_MS } from "./text-response-config.js";

// Independent schema/version counter for the CC-snapshot contract - never
// compared to cc-summary's "1.0", cc-status's "1.0", cc-knowledge's "1.0" or
// the router API's "2.0". Same principle as every other contract in this
// repo: separate contracts, separate counters, never kept in sync.
export const CC_SNAPSHOT_SCHEMA_VERSION = "1.0";

// Approved contract limits (Chat-Freigabe): 30 alerts, 10 ranked items, 200
// chars for nextStepSummary. The remaining per-domain array limits mirror
// the approved 30 for consistency across the five sections; none of these
// was separately negotiated, so they are documented here as the same,
// already-agreed default rather than a new, undiscussed value.
export const CC_SNAPSHOT_MAX_ALERTS = 30;
export const CC_SNAPSHOT_MAX_SERVICES = 30;
export const CC_SNAPSHOT_MAX_GIT_REPOSITORIES = 30;
export const CC_SNAPSHOT_MAX_FAILED_CHECKS = 30;
export const CC_SNAPSHOT_MAX_PROJECTS = 30;
export const CC_SNAPSHOT_MAX_RANKED_ITEMS = 10;

export const CC_SNAPSHOT_MAX_NEXT_STEP_SUMMARY_CHARS = 200;
export const CC_SNAPSHOT_MAX_KNOWLEDGE_QUERY_CHARS = 500;
export const CC_SNAPSHOT_MAX_KNOWLEDGE_HITS = 3;

// Five domains x up to 30 items each, each item carrying several bounded
// text/id/enum fields - larger than cc-summary's/cc-knowledge's 16 KiB
// (a single flat context object) but still a small, explicit ceiling, not
// an open-ended body.
export const CC_SNAPSHOT_MAX_REQUEST_BYTES = 65_536;

// Mirrors cc-summary's/cc-knowledge's own scoped timeout and
// concurrency/rate limits - independent of /api/router/respond and every
// other CC endpoint, via the same existing env-driven knobs.
export const CC_SNAPSHOT_NORMAL_TIMEOUT_MS = 20_000;
export const CC_SNAPSHOT_ABSOLUTE_TIMEOUT_MS = 30_000;
export const CC_SNAPSHOT_MAX_CONCURRENT_REQUESTS = 1;
export const CC_SNAPSHOT_MAX_REQUESTS_PER_WINDOW = 1;

// Same 2 KiB cap the approved contract specifies for narrative.text.
export const CC_SNAPSHOT_MAX_NARRATIVE_BYTES = 2 * 1024;

// Ceiling for narrative.retryAfterSeconds - only ever taken from the shared
// rate limiter's own Retry-After header (see cc-summary-config.js, same
// reasoning): derived from the limiter's fixed window, never a separate
// literal, never guessed.
export const CC_SNAPSHOT_MAX_RETRY_AFTER_SECONDS = Math.ceil(TEXT_RESPONSE_RATE_WINDOW_MS / 1000);

export const CC_SNAPSHOT_NARRATIVE_STATES = Object.freeze([
  "ok", "not_connected", "model_missing", "timeout", "invalid_response", "temporarily_unavailable"
]);

// Evidence tri-state, identical vocabulary to recommendation-contract.js's
// EVIDENCE_STATES - kept as its own local copy here since that file does not
// export it, same reasoning as every other per-endpoint contract file in
// this repo (cc-summary, cc-knowledge) keeping its own small, self-contained
// validators rather than depending on the recommendation engine's internals.
export const CC_SNAPSHOT_EVIDENCE_STATES = Object.freeze(new Set(["available", "unknown", "unavailable"]));

// Fixed domain processing order - used both for the deterministic ranking
// tie-break (Abschnitt 5 des Vertrags) and for iterating sections.
export const CC_SNAPSHOT_DOMAIN_ORDER = Object.freeze([
  "alerts", "services", "gitRepositories", "failedChecks", "projectProgress"
]);

// Which field on a normalized item carries its domain-specific identity.
export const CC_SNAPSHOT_ID_FIELD = Object.freeze({
  alerts: "alertId",
  services: "serviceId",
  gitRepositories: "repoId",
  failedChecks: "checkId",
  projectProgress: "projectId"
});

// Which field on a normalized item carries the value the urgency mapping
// keys off. alerts/failedChecks use "severity", the others use "status" (or
// "progressStatus" for projectProgress, matching the request field name in
// the approved contract).
export const CC_SNAPSHOT_URGENCY_FIELD = Object.freeze({
  alerts: "severity",
  services: "status",
  gitRepositories: "status",
  failedChecks: "severity",
  projectProgress: "progressStatus"
});

export const CC_SNAPSHOT_ALERT_SEVERITIES = Object.freeze(new Set(["critical", "warning", "notice", "unknown", "unavailable"]));
export const CC_SNAPSHOT_SERVICE_STATUSES = Object.freeze(new Set(["ok", "degraded", "down", "unknown", "unavailable"]));
export const CC_SNAPSHOT_GIT_STATUSES = Object.freeze(new Set(["clean", "dirty", "conflict", "diverged", "unknown", "unavailable"]));
// failedChecks.severity has no separate "unavailable": an entry's mere
// presence in failedChecks.items already is the evidenced fact of a
// failure (see the approved contract's Abschnitt 5 Sonderregel) - a missing
// or invalid severity sub-field normalizes to "unknown", not "unavailable",
// because there is no meaningful "not delivered" state for a
// sub-classification of an already-evidenced item.
export const CC_SNAPSHOT_FAILED_CHECK_SEVERITIES = Object.freeze(new Set(["blocking", "non-blocking", "unknown"]));
export const CC_SNAPSHOT_FAILED_CHECK_KINDS = Object.freeze(new Set(["test", "scan", "build", "unknown"]));
export const CC_SNAPSHOT_PROJECT_PROGRESS_STATUSES = Object.freeze(new Set(["on-track", "blocked", "overdue", "unknown", "unavailable"]));
export const CC_SNAPSHOT_IMPACT_SCOPES = Object.freeze(new Set(["single-project", "cross-project", "infrastructure-wide", "unknown"]));

// Dringlichkeit (urgency) mapping tables - fixed, deterministic, part of the
// vertrag itself, never computed per-instance. `null` means "excluded from
// ranking, listed in unranked instead" (Abschnitt 5 des Vertrags).
export const CC_SNAPSHOT_URGENCY_MAP = Object.freeze({
  alerts: Object.freeze({ critical: 3, warning: 2, notice: 1, unknown: null, unavailable: null }),
  services: Object.freeze({ down: 3, degraded: 2, ok: null, unknown: null, unavailable: null }),
  gitRepositories: Object.freeze({ conflict: 3, diverged: 2, dirty: 1, clean: null, unknown: null, unavailable: null }),
  // Sonderregel: severity "unknown" is included with the same score as
  // "non-blocking" (=1), not excluded - see
  // CC_SNAPSHOT_FAILED_CHECK_SEVERITIES above for the reasoning.
  failedChecks: Object.freeze({ blocking: 3, "non-blocking": 1, unknown: 1 }),
  projectProgress: Object.freeze({ blocked: 3, overdue: 2, "on-track": null, unknown: null, unavailable: null })
});

// Auswirkung (impact) mapping - domain-independent, keyed by impactScope.
// "unknown" gets the lowest non-excluded weight (1), a fixed conservative
// default, never guessed per instance.
export const CC_SNAPSHOT_IMPACT_MAP = Object.freeze({
  "infrastructure-wide": 3,
  "cross-project": 2,
  "single-project": 1,
  unknown: 1
});
