import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appLauncher } from "../orchestrator/action/app-launcher.js";

// R7 - a fixed 32+ char test token, same shape authenticateInternalRequest
// requires for every other internal-auth-gated surface in this repo (see
// test/internal-auth.test.js). Every approval request in this file must now
// carry it - see test/action-approval-auth.test.js for the tests that cover
// what happens when it is missing/wrong.
const TEST_APPROVAL_TOKEN = "test-approval-token-0123456789abcdef";

function approvalHeaders() {
  return { "content-type": "application/json", authorization: `Bearer ${TEST_APPROVAL_TOKEN}` };
}

// R5 - the HTTP surface for the approval decision: POST /api/actions/:id/approval
// and GET /api/actions/:id. Isolated DATA_DIR per test run, same pattern
// test/cc-status.test.js's "existing router endpoints remain unchanged" test
// already uses, so real disk-backed pending records never leak between runs.
async function withServer(t, fn) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-action-api-"));
  const previousDataDir = process.env.AI_ROUTER_DATA_DIR;
  const previousApprovalToken = process.env.AI_ROUTER_APPROVAL_TOKEN;
  process.env.AI_ROUTER_DATA_DIR = dataDir;
  process.env.AI_ROUTER_APPROVAL_TOKEN = TEST_APPROVAL_TOKEN;
  const { createRouterServer } = await import(`../orchestrator/server.js?t=${Date.now()}_${Math.random()}`);
  const server = createRouterServer({ eventLogger: { log: async () => {} } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    if (previousDataDir === undefined) delete process.env.AI_ROUTER_DATA_DIR; else process.env.AI_ROUTER_DATA_DIR = previousDataDir;
    if (previousApprovalToken === undefined) delete process.env.AI_ROUTER_APPROVAL_TOKEN; else process.env.AI_ROUTER_APPROVAL_TOKEN = previousApprovalToken;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function askOpenSpotify(baseUrl) {
  const response = await fetch(`${baseUrl}/api/jarvis/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "Öffne Spotify." })
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("a resolved, approval-gated action is persisted and reachable via GET /api/actions/:id", async (t) => {
  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    assert.equal(ask.actionStatus, "approval_required");
    assert.equal(ask.approvalRequired, true);
    assert.ok(ask.actionRequestId);

    const getResponse = await fetch(`${baseUrl}/api/actions/${ask.actionRequestId}`);
    assert.equal(getResponse.status, 200);
    const body = await getResponse.json();
    assert.equal(body.pending.status, "approval_required");
    assert.equal(body.pending.actionId, "app.open");
  });
});

test("POST .../approval with decision=approve resumes and executes the persisted request", async (t) => {
  // R6 - app.open now has a real executor that launches a real Windows
  // process (app-launcher.js). This is an HTTP-level pipeline test, not a
  // launcher test (app-launcher.test.js covers spawn/allowlist behaviour in
  // isolation with an injected spawnImpl) - so only the leaf OS call is
  // substituted here, via the same exported singleton the production
  // registry calls at execution time (action-registry.js's app.open
  // executor does a live `appLauncher.launch(...)` lookup, and this test's
  // plain, non-cache-busted import resolves to the identical module
  // instance the freshly-imported server.js transitively uses). Everything
  // above the launcher - intent resolution, approval, resume, audit - runs
  // for real.
  const originalLaunch = appLauncher.launch;
  appLauncher.launch = async (app) => ({ ok: true, app, state: "opened" });
  t.after(() => { appLauncher.launch = originalLaunch; });

  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    const response = await fetch(`${baseUrl}/api/actions/${ask.actionRequestId}/approval`, {
      method: "POST",
      headers: approvalHeaders(),
      body: JSON.stringify({ decision: "approve", decidedBy: "felix" })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "completed");
    assert.equal(body.executed, true);
    assert.equal(body.error, null);
    assert.deepEqual(body.result, { ok: true, app: "spotify", state: "opened" });

    // Replay is blocked afterwards.
    const replay = await fetch(`${baseUrl}/api/actions/${ask.actionRequestId}/approval`, {
      method: "POST",
      headers: approvalHeaders(),
      body: JSON.stringify({ decision: "approve", decidedBy: "felix" })
    });
    assert.equal(replay.status, 409);
    const replayBody = await replay.json();
    assert.equal(replayBody.error.code, "ACTION_PENDING_ALREADY_DECIDED");
  });
});

test("POST .../approval with decision=approve normalizes a real launch failure without a fabricated success", async (t) => {
  const originalLaunch = appLauncher.launch;
  appLauncher.launch = async () => {
    const error = new Error("app-launcher.js unit tests cover the real spawn path; this is APP_NOT_INSTALLED simulated at the HTTP level.");
    error.code = "APP_NOT_INSTALLED";
    throw error;
  };
  t.after(() => { appLauncher.launch = originalLaunch; });

  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    const response = await fetch(`${baseUrl}/api/actions/${ask.actionRequestId}/approval`, {
      method: "POST",
      headers: approvalHeaders(),
      body: JSON.stringify({ decision: "approve", decidedBy: "felix" })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "failed");
    assert.equal(body.executed, false);
    assert.equal(body.error.code, "APP_NOT_INSTALLED");
  });
});

test("POST .../approval with decision=reject terminates the request without executing it", async (t) => {
  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    const response = await fetch(`${baseUrl}/api/actions/${ask.actionRequestId}/approval`, {
      method: "POST",
      headers: approvalHeaders(),
      body: JSON.stringify({ decision: "reject", decidedBy: "felix", note: "nicht jetzt" })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "rejected");
    assert.equal(body.executed, false);
  });
});

test("a decision for an unknown action request id returns 404", async (t) => {
  await withServer(t, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/actions/act_1_deadbeef/approval`, {
      method: "POST",
      headers: approvalHeaders(),
      body: JSON.stringify({ decision: "approve", decidedBy: "felix" })
    });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, "ACTION_PENDING_NOT_FOUND");
  });
});

test("GET of an unknown action request id returns 404", async (t) => {
  await withServer(t, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/actions/act_1_deadbeef`);
    assert.equal(response.status, 404);
  });
});
