// R7 - Approval Source Hardening + Action Rate Limit. Covers the rate
// limiter in front of actionApprovalService.decide() for decision "approve"
// (config.js: ACTION_APPROVAL_MAX_EXECUTIONS_PER_WINDOW=5,
// ACTION_APPROVAL_RATE_WINDOW_MS=60_000). Auth is assumed valid throughout -
// see test/action-approval-auth.test.js for the auth gate itself. R5
// replay/expiry behaviour is unaffected and covered in
// test/action-approval-resume.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appLauncher } from "../orchestrator/action/app-launcher.js";

const TEST_APPROVAL_TOKEN = "test-approval-token-0123456789abcdef";

function approvalHeaders() {
  return { "content-type": "application/json", authorization: `Bearer ${TEST_APPROVAL_TOKEN}` };
}

async function withServer(t, fn, { now } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-action-rate-"));
  const previousDataDir = process.env.AI_ROUTER_DATA_DIR;
  const previousApprovalToken = process.env.AI_ROUTER_APPROVAL_TOKEN;
  process.env.AI_ROUTER_DATA_DIR = dataDir;
  process.env.AI_ROUTER_APPROVAL_TOKEN = TEST_APPROVAL_TOKEN;
  const { createRouterServer } = await import(`../orchestrator/server.js?t=${Date.now()}_${Math.random()}`);
  const server = createRouterServer({ eventLogger: { log: async () => {} }, ...(now ? { now } : {}) });
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

function approve(baseUrl, requestId, extraBody = {}) {
  return fetch(`${baseUrl}/api/actions/${requestId}/approval`, {
    method: "POST",
    headers: approvalHeaders(),
    body: JSON.stringify({ decision: "approve", decidedBy: "felix", ...extraBody })
  });
}

function reject(baseUrl, requestId) {
  return fetch(`${baseUrl}/api/actions/${requestId}/approval`, {
    method: "POST",
    headers: approvalHeaders(),
    body: JSON.stringify({ decision: "reject", decidedBy: "felix" })
  });
}

function stubLaunch(t, { counter } = {}) {
  const originalLaunch = appLauncher.launch;
  appLauncher.launch = async (app) => {
    if (counter) counter.value += 1;
    return { ok: true, app, state: "opened" };
  };
  t.after(() => { appLauncher.launch = originalLaunch; });
}

test("up to the configured maximum of real approvals within the window are all allowed", async (t) => {
  stubLaunch(t);
  await withServer(t, async (baseUrl) => {
    for (let i = 0; i < 5; i += 1) {
      const ask = await askOpenSpotify(baseUrl);
      const response = await approve(baseUrl, ask.actionRequestId);
      assert.equal(response.status, 200, `approval ${i} should be allowed`);
    }
  });
});

test("the 6th real approval within the window is blocked with ACTION_RATE_LIMITED and never reaches the executor", async (t) => {
  const counter = { value: 0 };
  stubLaunch(t, { counter });

  await withServer(t, async (baseUrl) => {
    for (let i = 0; i < 5; i += 1) {
      const ask = await askOpenSpotify(baseUrl);
      const response = await approve(baseUrl, ask.actionRequestId);
      assert.equal(response.status, 200);
    }
    assert.equal(counter.value, 5);

    const sixthAsk = await askOpenSpotify(baseUrl);
    const blocked = await approve(baseUrl, sixthAsk.actionRequestId);
    assert.equal(blocked.status, 429);
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.error.code, "ACTION_RATE_LIMITED");
    assert.ok(Number.isFinite(blockedBody.retryAfterMs) && blockedBody.retryAfterMs > 0);
    assert.equal(blocked.headers.get("retry-after"), String(Math.ceil(blockedBody.retryAfterMs / 1000)));
    assert.equal(counter.value, 5, "the rate-limited request must never reach the executor");

    // The blocked request is untouched, not consumed by the block - it can
    // still be approved later, once the window allows it.
    const pendingResponse = await fetch(`${baseUrl}/api/actions/${sixthAsk.actionRequestId}`);
    const pending = await pendingResponse.json();
    assert.equal(pending.pending.status, "approval_required");
  });
});

test("after the rate-limit window elapses, approvals are allowed again", async (t) => {
  stubLaunch(t);
  const clock = { value: 1_000_000 };

  await withServer(t, async (baseUrl) => {
    for (let i = 0; i < 5; i += 1) {
      const ask = await askOpenSpotify(baseUrl);
      const response = await approve(baseUrl, ask.actionRequestId);
      assert.equal(response.status, 200);
    }

    const blockedAsk = await askOpenSpotify(baseUrl);
    const blocked = await approve(baseUrl, blockedAsk.actionRequestId);
    assert.equal(blocked.status, 429);

    clock.value += 60_001;

    const allowedAgain = await approve(baseUrl, blockedAsk.actionRequestId);
    assert.equal(allowedAgain.status, 200);
  }, { now: () => clock.value });
});

test("replaying an already-decided request does not consume rate-limit budget and never turns into ACTION_RATE_LIMITED", async (t) => {
  stubLaunch(t);
  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    const first = await approve(baseUrl, ask.actionRequestId);
    assert.equal(first.status, 200);

    // 10 replays of the SAME already-decided id (more than the limit) must
    // keep returning 409, never flip to 429.
    for (let i = 0; i < 10; i += 1) {
      const replay = await approve(baseUrl, ask.actionRequestId);
      assert.equal(replay.status, 409);
      const replayBody = await replay.json();
      assert.equal(replayBody.error.code, "ACTION_PENDING_ALREADY_DECIDED");
    }

    // Full budget (minus the one legitimate approval above) is still there.
    for (let i = 0; i < 4; i += 1) {
      const nextAsk = await askOpenSpotify(baseUrl);
      const response = await approve(baseUrl, nextAsk.actionRequestId);
      assert.equal(response.status, 200);
    }
    const overBudgetAsk = await askOpenSpotify(baseUrl);
    const overBudget = await approve(baseUrl, overBudgetAsk.actionRequestId);
    assert.equal(overBudget.status, 429);
  });
});

test("reject decisions do not consume approve rate-limit budget", async (t) => {
  await withServer(t, async (baseUrl) => {
    for (let i = 0; i < 10; i += 1) {
      const ask = await askOpenSpotify(baseUrl);
      const response = await reject(baseUrl, ask.actionRequestId);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, "rejected");
    }

    stubLaunch(t);
    const ask = await askOpenSpotify(baseUrl);
    const response = await approve(baseUrl, ask.actionRequestId);
    assert.equal(response.status, 200, "10 prior rejects must not have consumed any approve budget");
  });
});

test("a failed-auth attempt does not consume rate-limit budget", async (t) => {
  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    for (let i = 0; i < 10; i += 1) {
      const response = await fetch(`${baseUrl}/api/actions/${ask.actionRequestId}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve", decidedBy: "felix" })
      });
      assert.equal(response.status, 401);
    }

    stubLaunch(t);
    const response = await approve(baseUrl, ask.actionRequestId);
    assert.equal(response.status, 200, "10 prior failed-auth attempts must not have consumed any approve budget");
  });
});

test("the limit cannot be bypassed by a freely invented actor/source in the request body", async (t) => {
  stubLaunch(t);
  await withServer(t, async (baseUrl) => {
    for (let i = 0; i < 5; i += 1) {
      const ask = await askOpenSpotify(baseUrl);
      const response = await approve(baseUrl, ask.actionRequestId, { actor: `spoofed-actor-${i}`, source: `spoofed-source-${i}` });
      assert.equal(response.status, 200);
    }

    const sixthAsk = await askOpenSpotify(baseUrl);
    const blocked = await approve(baseUrl, sixthAsk.actionRequestId, { actor: "yet-another-actor", source: "yet-another-source" });
    assert.equal(blocked.status, 429);
  });
});
