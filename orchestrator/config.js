import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ALLOWED_REPOSITORIES = [REPOSITORY_ROOT];
// Stable, non-versioned launcher path. The hashed per-version subfolder this
// used to point at (...\bin\<hash>\codex.exe) is replaced on every Codex
// update and stops existing once superseded - this path is the one the
// installer keeps current across updates (verified 2026-08-30 against a real
// local install, codex-cli 0.130.0-alpha.5).
export const CODEX_FALLBACK = "C:\\Users\\felil\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MOCK_TIMEOUT_MS = 3_000;
export const MAX_TASK_LENGTH = 8_000;
export const MAX_CONTEXT_LENGTH = 1_000;
export const MAX_PROJECT_LENGTH = 120;
export const MAX_SOURCE_LENGTH = 40;
export const MAX_RESPONSE_LENGTH = 8_000;
export const MAX_STDERR_LENGTH = 16_384;
export const MAX_EVENT_COUNT = 200;
export const MAX_JSONL_LINE_LENGTH = 65_536;
export const MAX_RESULT_LENGTH = 4_000;
export const PROCESS_KILL_TIMEOUT_MS = 5_000;
export const PROCESS_SETTLE_TIMEOUT_MS = 2_000;
export const DATA_DIR = process.env.AI_ROUTER_DATA_DIR ? path.resolve(process.env.AI_ROUTER_DATA_DIR) : path.join(REPOSITORY_ROOT, ".ai-router-data");
export const RUNS_DIR = path.join(DATA_DIR, "runs");
export const LATEST_RUN_FILE = path.join(DATA_DIR, "latest-run.json");
export const COCKPIT_STATUS_FILE = path.join(DATA_DIR, "cockpit-status.json");
export const HISTORY_INDEX_FILE = path.join(DATA_DIR, "run-history.json");
export const ROUTER_VERSION = "0.13.0-test";
// Provider layer bounds (v0.13). Simulation only — no real external APIs.
export const MAX_PROVIDER_WORKFLOW_STEPS = 4;
export const MAX_PROVIDER_ALTERNATIVES = 3;
export const MAX_PROVIDER_SAFE_METADATA_KEYS = 8;
export const ROUTER_LOG_FILE = path.join(DATA_DIR, "router-events.jsonl");
export const MAX_LOG_BYTES = 512_000;
export const MAX_HISTORY_RUNS = 200;
export const DEFAULT_HISTORY_LIMIT = 25;
export const MAX_HISTORY_LIMIT = 100;
export const ADAPTER_STATUS_CACHE_MS = 60_000;
export const ROUTER_API_SCHEMA_VERSION = "2.0";
export const ROUTER_API_DEFAULT_MODE = "recommendation";
export const ROUTER_API_MAX_BODY_BYTES = 16_384;
export const ROUTER_API_TIMEOUT_MS = 3_500;
export const ROUTER_REQUEST_ID_MAX_LENGTH = 120;
export const RECOMMENDATION_SCHEMA_VERSION = "1.0";
export const RECOMMENDATION_MAX_BODY_BYTES = 32_768;
export const RECOMMENDATION_MAX_WORKFLOWS = 30;
export const RECOMMENDATION_MAX_ALERTS = 30;
export const RECOMMENDATION_MAX_AI_JOBS = 20;
export const RECOMMENDATION_MAX_ALTERNATIVES = 2;
// R5 - Action Resolution + Approval Resume. A pending action request (one
// awaiting a human decision) is persisted so it can be resumed by a later,
// unrelated HTTP call - unlike run-service.js's in-memory-only approval,
// which deliberately does not survive a process restart. TTL is short: this
// is a local, single-operator approval gate, not a long-lived workflow
// queue, and a stale pending request is a security liability, not a
// convenience.
export const ACTION_PENDING_DIR = path.join(DATA_DIR, "actions", "pending");
export const ACTION_PENDING_TTL_MS = 15 * 60_000;

// R7 - Approval Source Hardening + Action Rate Limit. Guards real action
// execution (POST /api/actions/:id/approval with decision "approve") against
// spam/automated repeat-approval, on top of R5's replay protection (which
// prevents the SAME request id from ever running twice, regardless of this
// limit). Deliberately generous for normal local, single-operator use - see
// docs/approval-source-hardening-r7.md for why these numbers were chosen.
export const ACTION_APPROVAL_MAX_EXECUTIONS_PER_WINDOW = 5;
export const ACTION_APPROVAL_RATE_WINDOW_MS = 60_000;

export const ROUTER_ALLOWED_ORIGINS = Object.freeze([
  "http://127.0.0.1:8787",
  "http://127.0.0.1:3000",
  "http://localhost:3000"
]);
