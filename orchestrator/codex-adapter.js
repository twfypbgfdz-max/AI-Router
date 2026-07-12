import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { CODEX_FALLBACK, MAX_EVENT_COUNT, MAX_JSONL_LINE_LENGTH, MAX_STDERR_LENGTH, PROCESS_KILL_TIMEOUT_MS } from "./config.js";
import { createJsonlParser, findFinalText } from "./jsonl.js";

export async function resolveCodexExecutable() {
  const configured = process.env.CODEX_EXECUTABLE?.trim();
  if (configured) {
    await fs.access(configured);
    return configured;
  }
  if (await canStart("codex")) return "codex";
  await fs.access(CODEX_FALLBACK);
  if (await canStart(CODEX_FALLBACK)) return CODEX_FALLBACK;
  throw new Error("Codex executable is not startable.");
}

function canStart(executable) {
  return new Promise((resolve) => {
    const child = spawn(executable, ["--version"], { shell: false, windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

export function buildCodexArgs(repository) {
  return ["-C", repository, "-s", "read-only", "-a", "never", "exec", "--ephemeral", "--ignore-user-config", "--strict-config", "--json", "--color", "never", "-"];
}

export function terminateProcessTree(child, { spawnImpl = spawn, timeoutMs = PROCESS_KILL_TIMEOUT_MS } = {}) {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve({ outcome: "already_exited" });
  if (process.platform !== "win32" || !child.pid) {
    child.kill("SIGTERM");
    return Promise.resolve({ outcome: "signal_sent" });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ outcome });
    };
    const killer = spawnImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true });
    const fallback = (outcome) => {
      if (child.exitCode === null && !child.killed) child.kill();
      finish(outcome);
    };
    const timer = setTimeout(() => {
      if (killer.exitCode === null && !killer.killed) killer.kill();
      fallback("taskkill_timeout");
    }, timeoutMs);
    killer.once("error", () => fallback("taskkill_start_failed"));
    killer.once("close", (code) => code === 0 ? finish("taskkill_succeeded") : fallback(`taskkill_exit_${code}`));
  });
}

export function runCodex({ repository, prompt, executable, spawnImpl = spawn, killSpawnImpl = spawn }) {
  let child;
  const operation = new Promise((resolve, reject) => {
    const parser = createJsonlParser({ maxEvents: MAX_EVENT_COUNT, maxLineLength: MAX_JSONL_LINE_LENGTH });
    child = spawnImpl(executable, buildCodexArgs(repository), { cwd: repository, shell: false, windowsHide: true });
    let stderr = "";
    child.stdout.on("data", (chunk) => parser.write(chunk.toString()));
    child.stderr.on("data", (chunk) => { if (stderr.length < MAX_STDERR_LENGTH) stderr += chunk.toString().slice(0, MAX_STDERR_LENGTH - stderr.length); });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      const parsed = parser.finish();
      resolve({ child, exitCode, signal, stderr, ...parsed, resultSummary: findFinalText(parsed.events) });
    });
    child.stdin.end(prompt);
  });
  operation.cancel = () => terminateProcessTree(child, { spawnImpl: killSpawnImpl });
  return operation;
}

export { CODEX_FALLBACK };
