import { TEXT_RESPONSE_RATE_WINDOW_MS } from "./text-response-config.js";

// Command-Center summary contract (v1). Independent schemaVersion counter,
// unrelated to the core router's "2.0" or the text-response pipeline's "1.0"
// - never compared or kept in sync with either.
export const CC_SUMMARY_SCHEMA_VERSION = "1.0";
export const CC_SUMMARY_REPORT_TYPES = Object.freeze(["project_status_summary"]);

export const CC_SUMMARY_MAX_REQUEST_BYTES = 16 * 1024;
// Deliberately below the 4 KiB orientation value: the shared text-response
// pipeline already caps every answer at TEXT_RESPONSE_MAX_OUTPUT_TOKENS=800
// (~2400 bytes at its ~3-bytes-per-token estimator, see context-limiter.js),
// so any cap at or above that is dead code - it would never be the
// operative bound. 2 KiB stays safely under that shared ceiling while still
// being the real, enforced limit for this endpoint's own visible summary.
export const CC_SUMMARY_MAX_VISIBLE_SUMMARY_BYTES = 2 * 1024;

// Absolute ceiling for the whole request, deliberately tighter than the
// shared /api/router/respond default (65s): a synchronous CC dashboard call
// must return in a bounded window. 20s is the expected normal case for a
// short local-model answer; 30s is the hard ceiling this endpoint will ever
// wait before failing closed into state "timeout".
export const CC_SUMMARY_NORMAL_TIMEOUT_MS = 20_000;
export const CC_SUMMARY_ABSOLUTE_TIMEOUT_MS = 30_000;

// No parallel summary calls, and at most one per window - reuses the shared
// text-response protection config (AI_ROUTER_MAX_CONCURRENT_REQUESTS /
// AI_ROUTER_MAX_REQUESTS_PER_MINUTE), scoped to this endpoint's own env copy
// so it never shares state or limits with /api/router/respond.
export const CC_SUMMARY_MAX_CONCURRENT_REQUESTS = 1;
export const CC_SUMMARY_MAX_REQUESTS_PER_WINDOW = 1;

export const CC_SUMMARY_STATES = Object.freeze([
  "ok", "not_connected", "model_missing", "timeout", "invalid_response",
  "input_rejected", "response_too_large", "temporarily_unavailable"
]);

// Ceiling for the optional retryAfterSeconds field: it is only ever taken
// from the shared rate limiter's own Retry-After header, whose value can
// never exceed its fixed window - derived from TEXT_RESPONSE_RATE_WINDOW_MS
// rather than duplicated as a separate literal. A value outside (0, this]
// cannot be a real limiter output and is dropped, never estimated.
export const CC_SUMMARY_MAX_RETRY_AFTER_SECONDS = Math.ceil(TEXT_RESPONSE_RATE_WINDOW_MS / 1000);
