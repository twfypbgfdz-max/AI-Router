import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-router-tests-"));
let exitCode = 1;

try {
  const result = spawnSync(process.execPath, ["--test"], {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, AI_ROUTER_DATA_DIR: temporaryDataDir }
  });
  exitCode = Number.isInteger(result.status) ? result.status : 1;
  if (result.error) console.error("Test runner could not start the Node.js test process.");
} finally {
  fs.rmSync(temporaryDataDir, { recursive: true, force: true });
}

process.exitCode = exitCode;
