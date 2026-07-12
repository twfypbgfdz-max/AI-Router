import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveCodexExecutable, runCodex } from "../orchestrator/codex-adapter.js";
import { createGitSafety } from "../orchestrator/git-safety.js";
import { createRunStore } from "../orchestrator/run-store.js";
import { createCockpitStatusStore } from "../orchestrator/cockpit-status.js";
import { RunService } from "../orchestrator/run-service.js";

function git(repository, args) {
  const result = spawnSync("git", ["-c", `safe.directory=${repository}`, "-C", repository, ...args], { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function waitForTerminal(service, runId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = service.get(runId);
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(run?.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Integration run did not reach a terminal state.");
}

test("controlled Codex integration test is opt-in", { skip: process.env.RUN_CODEX_INTEGRATION !== "1", timeout: 180_000 }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-codex-e2e-"));
  const repository = path.join(tempRoot, "temp-codex-integration-repo");
  const dataDir = path.join(tempRoot, "run-data");
  const runsDir = path.join(dataDir, "runs");
  const latestRunFile = path.join(dataDir, "latest-run.json");
  const cockpitFile = path.join(dataDir, "cockpit-status.json");
  try {
    await fs.mkdir(repository, { recursive: true });
    await fs.writeFile(path.join(repository, "README.md"), "# Synthetic Router Test\n\nThis is a disposable integration-test repository.\nIt contains no private or production data.\n", "utf8");
    await fs.writeFile(path.join(repository, "CHANGELOG.md"), "# Changelog\n\n## 1.2.3-test\n\nSynthetic integration-test version.\n", "utf8");
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Synthetic Integration Test"]);
    git(repository, ["config", "user.email", "synthetic-test@example.invalid"]);
    git(repository, ["add", "README.md", "CHANGELOG.md"]);
    git(repository, ["commit", "-m", "Create synthetic test fixture"]);
    git(repository, ["branch", "-M", "dev-test"]);

    const gitSafety = createGitSafety({ allowedRepositories: [repository] });
    const runStore = createRunStore({ runsDir, latestRunFile });
    const cockpitStore = createCockpitStatusStore({ file: cockpitFile });
    const states = [];
    let starts = 0;
    const adapter = {
      resolveCodexExecutable,
      runCodex(options) { starts += 1; return runCodex(options); }
    };
    const service = new RunService({
      adapter,
      git: gitSafety,
      persist: async (run) => { states.push(run.status); await runStore.saveRun(run); },
      publish: cockpitStore.saveCockpitStatus
    });
    const before = await gitSafety.captureGitState(repository);
    const created = await service.create({
      repository,
      task: "Lies README.md und CHANGELOG.md. Gib Projektname, dokumentierte Version und Zweck zurück. Verändere nichts."
    });
    const run = await waitForTerminal(service, created.runId);
    const stored = await runStore.loadRun(run.runId);
    const latest = await runStore.loadLatestRun();
    const cockpit = await cockpitStore.loadCockpitStatus();
    const after = await gitSafety.captureGitState(repository);

    assert.equal(starts, 1);
    assert.equal(run.status, "succeeded", run.errorSummary);
    assert.equal(run.exitCode, 0);
    assert.match(run.resultSummary, /Synthetic Router Test/i);
    assert.match(run.resultSummary, /1\.2\.3-test/i);
    assert.match(run.resultSummary, /(disposable|integration-test)/i);
    assert.ok(states.includes("validating") && states.includes("running") && states.includes("succeeded"));
    assert.ok(run.events.length > 0);
    assert.equal(JSON.stringify(stored.events).includes("tool_input"), false);
    assert.equal(stored.runId, run.runId);
    assert.equal(latest.runId, run.runId);
    assert.equal(cockpit.routerStatus, "succeeded");
    assert.equal(gitSafety.compareGitState(before, after).safe, true);
    assert.equal(after.branch, "dev-test");
    assert.equal(after.status, "");
    assert.equal(after.diffStat, "");
    assert.equal(after.stagedDiffStat, "");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
