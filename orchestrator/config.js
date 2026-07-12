import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ALLOWED_REPOSITORIES = [REPOSITORY_ROOT];
export const CODEX_FALLBACK = "C:\\Users\\felil\\AppData\\Local\\OpenAI\\Codex\\bin\\a7c12ebff69fb123\\codex.exe";
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MOCK_TIMEOUT_MS = 3_000;
export const MAX_TASK_LENGTH = 8_000;
export const MAX_STDERR_LENGTH = 16_384;
export const MAX_EVENT_COUNT = 200;
export const MAX_JSONL_LINE_LENGTH = 65_536;
export const MAX_RESULT_LENGTH = 4_000;
export const PROCESS_KILL_TIMEOUT_MS = 5_000;
export const PROCESS_SETTLE_TIMEOUT_MS = 2_000;
export const DATA_DIR = path.join(REPOSITORY_ROOT, ".ai-router-data");
export const RUNS_DIR = path.join(DATA_DIR, "runs");
export const LATEST_RUN_FILE = path.join(DATA_DIR, "latest-run.json");
export const COCKPIT_STATUS_FILE = path.join(DATA_DIR, "cockpit-status.json");
