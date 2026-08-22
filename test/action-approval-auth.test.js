// R7 - Approval Source Hardening. Before this, isTrustedMutation() (same-
// origin-or-no-origin) was the ONLY gate on POST /api/actions/:id/approval -
// any local caller could approve or reject any pending action. These tests
// cover the new authenticateInternalRequest() gate in server.js, in front of
// actionApprovalService.decide(): a valid AI_ROUTER_APPROVAL_TOKEN bearer
// token is now required, and source/actor are server-derived constants a
// client can never override via the request body. Rate-limit behaviour is
// covered separately in test/action-rate-limit.test.js; R5 replay/expiry
// behaviour is covered in test/action-approval-resume.test.js and is
// unaffected by this file's changes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appLauncher } from "../orchestrator/action/app-launcher.js";

const TEST_APPROVAL_TOKEN = "test-approval-token-0123456789abcdef";
const WRONG_APPROVAL_TOKEN = "wrong-approval-token-fedcba9876543210";

async function withServer(t, fn, { approvalToken = TEST_APPROVAL_TOKEN } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-action-auth-"));
  const previousDataDir = process.env.AI_ROUTER_DATA_DIR;
  const previousApprovalToken = process.env.AI_ROUTER_APPROVAL_TOKEN;
  process.env.AI_ROUTER_DATA_DIR = dataDir;
  if (approvalToken === null) delete process.env.AI_ROUTER_APPROVAL_TOKEN;
  else process.env.AI_ROUTER_APPROVAL_TOKEN = approvalToken;
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

function postApproval(baseUrl, requestId, { authorization, extraBody = {} } = {}) {
  const headers = { "content-type": "application/json" };
  if (authorization !== undefined) headers.authorization = authorization;
  return fetch(`${baseUrl}/api/actions/${requestId}/approval`, {
    method: "POST",
    headers,
    body: JSON.stringify({ decision: "approve", decidedBy: "felix", ...extraBody })
  });
}

test("approval with no Authorization header is rejected (401 APPROVAL_AUTH_REQUIRED), never reaches the executor", async (t) => {
  let launched = false;
  const originalLaunch = appLauncher.launch;
  appLauncher.launch = async (app) => { launched = true; return { ok: true, app, state: "opened" }; };
  t.after(() => { appLauncher.launch = originalLaunch; });

  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    const response = await postApproval(baseUrl, ask.actionRequestId);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, "APPROVAL_AUTH_REQUIRED");
    assert.equal(launched, false);

    // The pending request is untouched - still decidable once a valid
    // token is presented.
    const pendingResponse = await fetch(`${baseUrl}/api/actions/${ask.actionRequestId}`);
    const pending = await pendingResponse.json();
    assert.equal(pending.pending.status, "approval_required");
  });
});

test("approval with a wrong Authorization token is rejected (403 APPROVAL_SOURCE_UNTRUSTED), never reaches the executor", async (t) => {
  let launched = false;
  const originalLaunch = appLauncher.launch;
  appLauncher.launch = async (app) => { launched = true; return { ok: true, app, state: "opened" }; };
  t.after(() => { appLauncher.launch = originalLaunch; });

  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    const response = await postApproval(baseUrl, ask.actionRequestId, { authorization: `Bearer ${WRONG_APPROVAL_TOKEN}` });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.code, "APPROVAL_SOURCE_UNTRUSTED");
    assert.equal(launched, false);
  });
});

test("approval when the server has no approval token configured is denied, not silently allowed", async (t) => {
  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    const response = await postApproval(baseUrl, ask.actionRequestId, { authorization: "Bearer whatever-the-caller-sends" });
    assert.equal(response.status, 403);
    const body = await response.json();
    // AUTH_NOT_CONFIGURED collapses into the same untrusted-source response
    // as a wrong token - a caller must never learn "the server has no token
    // configured" as distinct information from "you sent the wrong token".
    assert.equal(body.error.code, "APPROVAL_SOURCE_UNTRUSTED");
  }, { approvalToken: null });
});

test("approval with a valid trusted token is accepted and executes", async (t) => {
  const originalLaunch = appLauncher.launch;
  appLauncher.launch = async (app) => ({ ok: true, app, state: "opened" });
  t.after(() => { appLauncher.launch = originalLaunch; });

  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    const response = await postApproval(baseUrl, ask.actionRequestId, { authorization: `Bearer ${TEST_APPROVAL_TOKEN}` });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "completed");
    assert.equal(body.executed, true);
  });
});

test("a rejection decision requires the same trust boundary as an approval", async (t) => {
  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    const noAuthReject = await fetch(`${baseUrl}/api/actions/${ask.actionRequestId}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", decidedBy: "felix" })
    });
    assert.equal(noAuthReject.status, 401);
    const body = await noAuthReject.json();
    assert.equal(body.error.code, "APPROVAL_AUTH_REQUIRED");

    // The same request is still open and can be rejected once authenticated.
    const authedReject = await fetch(`${baseUrl}/api/actions/${ask.actionRequestId}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_APPROVAL_TOKEN}` },
      body: JSON.stringify({ decision: "reject", decidedBy: "felix" })
    });
    assert.equal(authedReject.status, 200);
    const authedBody = await authedReject.json();
    assert.equal(authedBody.status, "rejected");
  });
});

test("a client cannot spoof its trust level by sending source/actor fields without a valid token", async (t) => {
  await withServer(t, async (baseUrl) => {
    const ask = await askOpenSpotify(baseUrl);
    const response = await postApproval(baseUrl, ask.actionRequestId, {
      extraBody: { source: "jarvis-ui", actor: "local-user" }
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, "APPROVAL_AUTH_REQUIRED");
  });
});

test("an unknown action request id stays rejected even with a valid trusted token", async (t) => {
  await withServer(t, async (baseUrl) => {
    const response = await postApproval(baseUrl, "act_1_deadbeef", { authorization: `Bearer ${TEST_APPROVAL_TOKEN}` });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, "ACTION_PENDING_NOT_FOUND");
  });
});
