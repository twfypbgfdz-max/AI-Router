import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createGitSafety } from "../orchestrator/git-safety.js";

function git(repository, args) {
  const result = spawnSync("git", ["-c", `safe.directory=${repository}`, "-C", repository, ...args], { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function initRepo(directory) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "README.md"), "# fixture\n", "utf8");
  git(directory, ["init"]);
  git(directory, ["config", "user.name", "Fixture"]);
  git(directory, ["config", "user.email", "fixture@example.invalid"]);
  git(directory, ["add", "README.md"]);
  git(directory, ["commit", "-m", "init"]);
}

test("working directory outside the allowlist is rejected without leaking its path", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-git-safety-"));
  try {
    const allowed = path.join(tempRoot, "allowed-repo");
    const outside = path.join(tempRoot, "outside-repo");
    await initRepo(allowed);
    await initRepo(outside);
    const gitSafety = createGitSafety({ allowedRepositories: [allowed] });
    await assert.rejects(gitSafety.captureGitState(outside), (error) => {
      assert.equal(error.code, "WORKING_DIRECTORY_NOT_ALLOWED");
      assert.equal(error.message.includes(outside), false);
      assert.equal(error.message.includes(tempRoot), false);
      return true;
    });
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
});

test("a path-traversal attempt via .. segments resolves outside the allowlist and is rejected", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-git-safety-"));
  try {
    const allowed = path.join(tempRoot, "allowed-repo");
    const escaped = path.join(tempRoot, "escaped-repo");
    await initRepo(allowed);
    await initRepo(escaped);
    const gitSafety = createGitSafety({ allowedRepositories: [allowed] });
    const traversalPath = path.join(allowed, "..", "escaped-repo");
    await assert.rejects(gitSafety.captureGitState(traversalPath), (error) => {
      assert.equal(error.code, "WORKING_DIRECTORY_NOT_ALLOWED");
      return true;
    });
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
});

test("a non-existent working directory is rejected safely instead of throwing a raw filesystem error", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-git-safety-"));
  try {
    const allowed = path.join(tempRoot, "allowed-repo");
    await initRepo(allowed);
    const gitSafety = createGitSafety({ allowedRepositories: [allowed] });
    await assert.rejects(gitSafety.captureGitState(path.join(allowed, "does-not-exist")), (error) => {
      assert.equal(error.code, "WORKING_DIRECTORY_NOT_ALLOWED");
      assert.equal(error.message.includes("ENOENT"), false);
      return true;
    });
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
});

test("a directory junction pointing outside the allowlist is rejected", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-git-safety-"));
  try {
    const allowed = path.join(tempRoot, "allowed-repo");
    const escaped = path.join(tempRoot, "escaped-repo");
    await initRepo(allowed);
    await initRepo(escaped);
    const link = path.join(tempRoot, "allowed-repo-link");
    try { await fs.symlink(escaped, link, "junction"); }
    catch { return; }
    const gitSafety = createGitSafety({ allowedRepositories: [allowed] });
    await assert.rejects(gitSafety.captureGitState(link), (error) => {
      assert.equal(error.code, "WORKING_DIRECTORY_NOT_ALLOWED");
      return true;
    });
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
});

test("the allowlisted repository itself is still accepted", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-git-safety-"));
  try {
    const allowed = path.join(tempRoot, "allowed-repo");
    await initRepo(allowed);
    const gitSafety = createGitSafety({ allowedRepositories: [allowed] });
    const state = await gitSafety.captureGitState(allowed);
    assert.equal(state.status, "");
    assert.ok(state.head);
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
});
