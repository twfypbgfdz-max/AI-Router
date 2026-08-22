// R9 - Run-Approval BFF (docs/run-approval-bff-r9.md). Before this,
// POST /api/runs/:id/approval was protected only by isTrustedMutation()
// (same-origin-or-no-origin, see docs/run-approval-trust-boundary-r8.md) -
// any local caller without an Origin header could approve or reject any
// waiting run. These tests cover:
//   - the hardened direct route now requiring the same AI_ROUTER_APPROVAL_TOKEN
//     bearer token as R7's /api/actions/:id/approval;
//   - the new browser-facing BFF route (POST /api/runs/:id/approval/ui),
//     which never sees or forwards that token, and is gated instead by a
//     single-use nonce minted only by this server's own GET /.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockAdapter } from "../orchestrator/mock-adapter.js";
import { RunService } from "../orchestrator/run-service.js";

const TEST_APPROVAL_TOKEN = "test-run-approval-token-0123456789ab";
const WRONG_APPROVAL_TOKEN = "wrong-run-approval-token-fedcba98765";
const finalStatuses = new Set(["succeeded", "failed", "cancelled", "timed_out", "awaiting_approval"]);

async function waitFor(service, runId, statuses = finalStatuses, maximumMs = 2_000) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    const run = service.get(runId);
    if (statuses.has(run?.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Run did not reach expected status.");
}

function newApprovalService() {
  const mock = createMockAdapter({ stepDelayMs: 1 });
  return new RunService({
    adapters: { mock: { run: (options) => mock.run(options), runRole: (options) => mock.runRole(options) } },
    git: { captureGitState: async () => ({ repository: "C:\\repo", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" }), compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {},
    publish: async () => {}
  });
}

async function withServer(t, fn, { approvalToken = TEST_APPROVAL_TOKEN } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-run-approval-bff-"));
  const previousDataDir = process.env.AI_ROUTER_DATA_DIR;
  const previousApprovalToken = process.env.AI_ROUTER_APPROVAL_TOKEN;
  process.env.AI_ROUTER_DATA_DIR = dataDir;
  if (approvalToken === null) delete process.env.AI_ROUTER_APPROVAL_TOKEN;
  else process.env.AI_ROUTER_APPROVAL_TOKEN = approvalToken;
  const { createRouterServer } = await import(`../orchestrator/server.js?t=${Date.now()}_${Math.random()}`);
  const service = newApprovalService();
  const server = createRouterServer({ service, eventLogger: { log: async () => {} } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl, service);
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    if (previousDataDir === undefined) delete process.env.AI_ROUTER_DATA_DIR; else process.env.AI_ROUTER_DATA_DIR = previousDataDir;
    if (previousApprovalToken === undefined) delete process.env.AI_ROUTER_APPROVAL_TOKEN; else process.env.AI_ROUTER_APPROVAL_TOKEN = previousApprovalToken;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function waitingRun(service, task = "Lösche alle Dateien und pushe auf main") {
  const created = await service.create({ task, adapter: "mock" });
  return waitFor(service, created.runId);
}

async function fetchNoncePage(baseUrl) {
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();
  const match = /name="approval-nonce" content="([0-9a-f]+)"/.exec(html);
  assert.ok(match, "GET / must embed an approval-nonce meta tag");
  return { html, nonce: match[1] };
}

function postUiApproval(baseUrl, runId, body) {
  return fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/approval/ui`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function postDirectApproval(baseUrl, runId, { authorization, decision = "approve" } = {}) {
  const headers = { "content-type": "application/json" };
  if (authorization !== undefined) headers.authorization = authorization;
  return fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/approval`, { method: "POST", headers, body: JSON.stringify({ decision }) });
}

test("GET / never embeds the approval token anywhere in the page", async (t) => {
  await withServer(t, async (baseUrl) => {
    const { html } = await fetchNoncePage(baseUrl);
    assert.equal(html.includes(TEST_APPROVAL_TOKEN), false);
  });
});

test("BFF: valid nonce + same-origin approves the run and never needs a token", async (t) => {
  await withServer(t, async (baseUrl, service) => {
    const waiting = await waitingRun(service);
    const { nonce } = await fetchNoncePage(baseUrl);
    const response = await postUiApproval(baseUrl, waiting.runId, { decision: "approve", decisionNote: "ok", nonce });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(["queued", "running"].includes(body.status));
    assert.equal(typeof body.approvalNonce, "string");
    assert.notEqual(body.approvalNonce, nonce);
  });
});

test("BFF: reject works through the same nonce boundary", async (t) => {
  await withServer(t, async (baseUrl, service) => {
    const waiting = await waitingRun(service);
    const { nonce } = await fetchNoncePage(baseUrl);
    const response = await postUiApproval(baseUrl, waiting.runId, { decision: "reject", nonce });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "cancelled");
  });
});

test("BFF: missing nonce is rejected (401 APPROVAL_NONCE_INVALID), run stays untouched", async (t) => {
  await withServer(t, async (baseUrl, service) => {
    const waiting = await waitingRun(service);
    const response = await postUiApproval(baseUrl, waiting.runId, { decision: "approve" });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, "APPROVAL_NONCE_INVALID");
    assert.equal(service.get(waiting.runId).approval.consumed, false);
  });
});

test("BFF: a nonce cannot be reused a second time", async (t) => {
  await withServer(t, async (baseUrl, service) => {
    const first = await waitingRun(service, "Lösche alle Dateien");
    const second = await waitingRun(service, "Produktiven Branch pushen");
    const { nonce } = await fetchNoncePage(baseUrl);
    const firstResponse = await postUiApproval(baseUrl, first.runId, { decision: "approve", nonce });
    assert.equal(firstResponse.status, 200);
    const replay = await postUiApproval(baseUrl, second.runId, { decision: "approve", nonce });
    assert.equal(replay.status, 401);
    const body = await replay.json();
    assert.equal(body.error.code, "APPROVAL_NONCE_INVALID");
    assert.equal(service.get(second.runId).approval.consumed, false);
  });
});

test("BFF: an unknown/foreign nonce is rejected", async (t) => {
  await withServer(t, async (baseUrl, service) => {
    const waiting = await waitingRun(service);
    const response = await postUiApproval(baseUrl, waiting.runId, { decision: "approve", nonce: "0".repeat(64) });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, "APPROVAL_NONCE_INVALID");
  });
});

test("BFF: fails closed when no approval token is configured, even with a valid nonce", async (t) => {
  await withServer(t, async (baseUrl, service) => {
    const waiting = await waitingRun(service);
    const { nonce } = await fetchNoncePage(baseUrl);
    const response = await postUiApproval(baseUrl, waiting.runId, { decision: "approve", nonce });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.code, "APPROVAL_SOURCE_UNTRUSTED");
    assert.equal(service.get(waiting.runId).approval.consumed, false);
  }, { approvalToken: null });
});

test("BFF: an unknown run id is normalized, never a fake success", async (t) => {
  await withServer(t, async (baseUrl) => {
    const { nonce } = await fetchNoncePage(baseUrl);
    const response = await postUiApproval(baseUrl, "run_unknown_deadbeef", { decision: "approve", nonce });
    assert.notEqual(response.status, 200);
    const body = await response.json();
    assert.notEqual(body.success, true);
  });
});

test("BFF: extra client-supplied fields (token, actor, source, url) are ignored - no generic proxy", async (t) => {
  await withServer(t, async (baseUrl, service) => {
    const waiting = await waitingRun(service);
    const { nonce } = await fetchNoncePage(baseUrl);
    const response = await postUiApproval(baseUrl, waiting.runId, {
      decision: "approve",
      nonce,
      token: "sneaky",
      authorization: `Bearer ${TEST_APPROVAL_TOKEN}`,
      url: "http://evil.example/",
      actor: "someone-else"
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(["queued", "running"].includes(body.status));
  });
});

test("direct route: no Authorization header is rejected (401 APPROVAL_AUTH_REQUIRED)", async (t) => {
  await withServer(t, async (baseUrl, service) => {
    const waiting = await waitingRun(service);
    const response = await postDirectApproval(baseUrl, waiting.runId);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, "APPROVAL_AUTH_REQUIRED");
    assert.equal(service.get(waiting.runId).approval.consumed, false);
  });
});

test("direct route: a wrong token is rejected (403 APPROVAL_SOURCE_UNTRUSTED)", async (t) => {
  await withServer(t, async (baseUrl, service) => {
    const waiting = await waitingRun(service);
    const response = await postDirectApproval(baseUrl, waiting.runId, { authorization: `Bearer ${WRONG_APPROVAL_TOKEN}` });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.code, "APPROVAL_SOURCE_UNTRUSTED");
  });
});

test("direct route: a valid operator token still works exactly as before", async (t) => {
  await withServer(t, async (baseUrl, service) => {
    const waiting = await waitingRun(service);
    const response = await postDirectApproval(baseUrl, waiting.runId, { authorization: `Bearer ${TEST_APPROVAL_TOKEN}` });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(["queued", "running"].includes(body.status));
  });
});
