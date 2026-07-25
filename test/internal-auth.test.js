import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("explicitly missing injected token ignores a foreign process environment token", () => {
  const script = `
    import { authenticateInternalRequest } from "./orchestrator/internal-auth.js";
    try {
      authenticateInternalRequest("Bearer fake-foreign-token-0123456789abcdef", {
        expectedToken: undefined
      });
      process.exit(1);
    } catch (error) {
      process.exit(error?.code === "AUTH_NOT_CONFIGURED" ? 0 : 2);
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      SystemRoot: process.env.SystemRoot,
      AI_ROUTER_INTERNAL_TOKEN: "fake-foreign-process-token-0123456789abcdef"
    },
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
