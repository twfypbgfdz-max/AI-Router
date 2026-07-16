import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger, KNOWN_LOG_EVENTS } from "../orchestrator/logger.js";

async function tempLogger() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-log-"));
  const file = path.join(dir, "router-events.jsonl");
  return { logger: createLogger({ file, maxBytes: 512_000 }), file, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("known log events cover the required operational events", () => {
  for (const event of ["server_started", "server_stopped", "health_checked", "diagnostics_checked", "adapter_check_started", "adapter_check_completed", "adapter_check_failed", "run_listed", "run_details_viewed", "run_cancel_requested", "run_cancel_completed", "run_cancel_failed"]) {
    assert.ok(KNOWN_LOG_EVENTS.includes(event), `missing event ${event}`);
  }
});

test("logging masks secrets and tokens in safe metadata", async () => {
  const { logger, file, cleanup } = await tempLogger();
  try {
    await logger.log({ event: "adapter_check_completed", safeMetadata: { apiKey: "api_key=abcdef123456", bearer: "Bearer abcdef.ghijkl.mnopqr", key: "sk-abcdefgh12345678", codex: "available" } });
    const raw = await fs.readFile(file, "utf8");
    assert.equal(raw.includes("abcdef123456"), false);
    assert.equal(raw.includes("abcdef.ghijkl.mnopqr"), false);
    assert.equal(raw.includes("sk-abcdefgh12345678"), false);
    assert.equal(raw.includes("[REDACTED]"), true);
    assert.equal(raw.includes("available"), true);
  } finally { await cleanup(); }
});

test("logging health reports presence, a coarse size class and a status without a path", async () => {
  const { logger, cleanup } = await tempLogger();
  try {
    const before = await logger.health();
    assert.equal(before.present, false);
    assert.equal(before.sizeClass, "none");
    assert.equal(before.status, "ok");
    await logger.log({ event: "health_checked" });
    const after = await logger.health();
    assert.equal(after.present, true);
    assert.ok(["small", "medium", "large"].includes(after.sizeClass));
    assert.deepEqual(Object.keys(after).sort(), ["present", "sizeClass", "status"]);
  } finally { await cleanup(); }
});

test("logging health is unavailable when the log directory cannot be created", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-log-bad-"));
  const blocker = path.join(dir, "blocker");
  await fs.writeFile(blocker, "x", "utf8");
  try {
    // A file sits where a directory would need to be, so mkdir fails.
    const logger = createLogger({ file: path.join(blocker, "nested", "router-events.jsonl") });
    const health = await logger.health();
    assert.equal(health.status, "unavailable");
    assert.equal(health.present, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
