// Independent schema/version counter for the CC-reindex contract - never
// compared to cc-status's "1.0", cc-summary's "1.0", cc-knowledge's "1.0",
// cc-snapshot's "1.0" or the router API's "2.0". Same principle as every
// other contract in this repo: separate contracts, separate counters, never
// kept in sync.
export const CC_REINDEX_SCHEMA_VERSION = "1.0";

// A full reindex embeds every chunk of every changed document sequentially
// against the local Ollama embedding model - slower than a single answer
// generation, but still a small, manually-triggered allowlist (currently 10
// documents). 120s is a generous fixed ceiling for that bulk local
// operation, not a per-document estimate.
export const CC_REINDEX_TIMEOUT_MS = 120_000;

// Same reasoning as cc-knowledge/cc-summary/cc-snapshot: a state-changing
// operation on shared router-owned data gets the same conservative single-
// slot scoping, independent of every other CC endpoint's own limiter.
export const CC_REINDEX_MAX_CONCURRENT_REQUESTS = 1;
export const CC_REINDEX_MAX_REQUESTS_PER_WINDOW = 1;
export const CC_REINDEX_RATE_WINDOW_MS = 60_000;
