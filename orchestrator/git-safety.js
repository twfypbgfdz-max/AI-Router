import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ALLOWED_REPOSITORIES } from "./config.js";

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function git(repository, args) {
  const result = await run("git", ["-c", `safe.directory=${repository}`, "-C", repository, ...args], repository);
  if (result.code !== 0) throw new Error(`Git check failed: ${result.stderr || args.join(" ")}`);
  return result.stdout;
}

async function canonicalRepositoryWithAllowlist(inputPath, allowedRepositories) {
  const resolved = await fs.realpath(inputPath);
  const allowed = await Promise.all(allowedRepositories.map((item) => fs.realpath(item)));
  if (!allowed.includes(resolved)) throw new Error("Repository is not allowlisted.");
  return resolved;
}

async function captureGitStateWithAllowlist(inputPath, allowedRepositories) {
  const repository = await canonicalRepositoryWithAllowlist(inputPath, allowedRepositories);
  const topLevel = await git(repository, ["rev-parse", "--show-toplevel"]);
  if (path.resolve(topLevel) !== repository) throw new Error("Git top-level does not match the allowlisted repository.");
  const [branch, head, status, diffStat, stagedDiffStat] = await Promise.all([
    git(repository, ["branch", "--show-current"]),
    git(repository, ["rev-parse", "HEAD"]),
    git(repository, ["status", "--porcelain=v1"]),
    git(repository, ["diff", "--stat"]),
    git(repository, ["diff", "--cached", "--stat"])
  ]);
  return { repository, topLevel, branch, head, status, diffStat, stagedDiffStat };
}

export function compareGitState(before, after) {
  const changed = ["branch", "head", "status", "diffStat", "stagedDiffStat"].filter((key) => before[key] !== after[key]);
  return { safe: changed.length === 0, changed };
}

export function createGitSafety({ allowedRepositories }) {
  const fixedAllowlist = [...allowedRepositories];
  return {
    canonicalRepository: (inputPath) => canonicalRepositoryWithAllowlist(inputPath, fixedAllowlist),
    captureGitState: (inputPath) => captureGitStateWithAllowlist(inputPath, fixedAllowlist),
    compareGitState
  };
}

const productionGitSafety = createGitSafety({ allowedRepositories: ALLOWED_REPOSITORIES });
export const canonicalRepository = productionGitSafety.canonicalRepository;
export const captureGitState = productionGitSafety.captureGitState;
