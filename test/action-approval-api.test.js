import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// R5 - the HTTP surface for the approval decision: POST /api/actions/:id/approval
// and GET /api/actions/:id. Isolated DATA_DIR per test run, same pattern
// test/cc-status.test.js's "existing router endpoints remain unchanged" test
// already uses, so real disk-backed pending records never leak between runs.
async function withServer(t, fn) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-action-api-"));
  const previous = process.env.AI_ROUTER_DATA_DIR;
  process.env.AI_ROUTER_DATA_DIR = dataDir;
  const { createRouterServer } = await import(`../orchestrator/server.js?t=${Date.now()}_${Math.random()}`);
  const server = createRouterServer({ eventLogger: { log: async () => {} } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    if (previous === undefined) delete process.env.AI_ROUTER_DATA_DIR; else process.env.AI_ROUTER_DATA_DIR = previous;
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
  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    const response = await fetch(`${baseUrl}/api/actions/${ask.actionRequestId}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", decidedBy: "felix" })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    // app.open has no real executor in R5 - approval must lead to a closed
    // failure (ACTION_EXECUTOR_UNAVAILABLE), never a fabricated success.
    assert.equal(body.status, "failed");
    assert.equal(body.executed, false);
    assert.equal(body.error.code, "ACTION_EXECUTOR_UNAVAILABLE");

    // Replay is blocked afterwards.
    const replay = await fetch(`${baseUrl}/api/actions/${ask.actionRequestId}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", decidedBy: "felix" })
    });
    assert.equal(replay.status, 409);
    const replayBody = await replay.json();
    assert.equal(replayBody.error.code, "ACTION_PENDING_ALREADY_DECIDED");
  });
});

test("POST .../approval with decision=reject terminates the request without executing it", async (t) => {
  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    const response = await fetch(`${baseUrl}/api/actions/${ask.actionRequestId}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
      headers: { "content-type": "application/json" },
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
