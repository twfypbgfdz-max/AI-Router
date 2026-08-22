// R9 - Documented Threat Model B boundary test (see
// docs/run-approval-bff-r9.md, section 2a). NOT a bug report - this is the
// accepted, deliberate scope of the R9 nonce/BFF design after the security
// review that led to that section.
//
// Threat Model A (foreign web origin / CSRF) is what the nonce in
// orchestrator/approval-nonce-store.js actually protects: a malicious page
// on a different origin cannot read the response of GET / (Same-Origin
// Policy) and so cannot extract the nonce.
//
// Threat Model B (any local process/script running as the same Windows
// user as the AI-Router) is explicitly OUT OF SCOPE for R9 - see
// docs/run-approval-bff-r9.md section 2a for why that matches the rest of
// Felix Core's existing local-trust model (AI_ROUTER_CC_TOKEN etc. are
// already plain Windows-user environment variables, readable by any
// process running as that same user). This test documents that scope by
// proving it end-to-end: a plain fetch() client (standing in for
// curl/PowerShell/any local script, no browser involved) performs exactly
// the same GET / -> extract nonce -> POST flow the served page's decide()
// function performs, and succeeds. AI_ROUTER_APPROVAL_TOKEN is never used,
// read, or required anywhere in this script - which is also the point:
// Threat Model B bypasses the nonce, but never exposes the token itself.
//
// If a future change removes this bypass (i.e. actually closes Threat
// Model B), this test's final assertion must change from expecting success
// to expecting rejection - and docs/run-approval-bff-r9.md section 2a must
// be updated in the same change, not left describing a boundary that no
// longer exists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockAdapter } from "../orchestrator/mock-adapter.js";
import { RunService } from "../orchestrator/run-service.js";

const TEST_APPROVAL_TOKEN = "test-run-approval-token-0123456789ab";

function newApprovalService() {
  const mock = createMockAdapter({ stepDelayMs: 1 });
  return new RunService({
    adapters: { mock: { run: (options) => mock.run(options), runRole: (options) => mock.runRole(options) } },
    git: { captureGitState: async () => ({ repository: "C:\\repo", branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" }), compareGitState: () => ({ safe: true, changed: [] }) },
    persist: async () => {},
    publish: async () => {}
  });
}

async function withServer(t, fn) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-threat-model-"));
  const previousDataDir = process.env.AI_ROUTER_DATA_DIR;
  const previousApprovalToken = process.env.AI_ROUTER_APPROVAL_TOKEN;
  process.env.AI_ROUTER_DATA_DIR = dataDir;
  process.env.AI_ROUTER_APPROVAL_TOKEN = TEST_APPROVAL_TOKEN;
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

async function waitFor(service, runId, statuses = new Set(["awaiting_approval"]), maximumMs = 2_000) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    const run = service.get(runId);
    if (statuses.has(run?.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Run did not reach expected status.");
}

test("Threat Model B boundary (accepted, documented): a plain fetch() client (no browser, standing in for curl) can GET /, extract the nonce, and successfully approve a run via the BFF - never touching AI_ROUTER_APPROVAL_TOKEN", async (t) => {
  await withServer(t, async (baseUrl, service) => {
    const created = await service.create({ task: "Lösche alle Dateien und pushe auf main", adapter: "mock" });
    const waiting = await waitFor(service, created.runId);

    // Step 1: GET / with no browser-specific headers at all - no Origin, no
    // Referer, no cookie, no user-agent trickery. This is exactly what
    // `curl http://127.0.0.1:8787/` produces.
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const nonceMatch = /name="approval-nonce" content="([0-9a-f]+)"/.exec(html);
    assert.ok(nonceMatch, "the nonce is plain text in the response body - trivially regex-extractable");
    const stolenNonce = nonceMatch[1];

    // Step 2: POST the BFF route with that nonce. No Authorization header,
    // no AI_ROUTER_APPROVAL_TOKEN anywhere in this script - and none needed.
    const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(waiting.runId)}/approval/ui`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", nonce: stolenNonce })
    });

    // Expected and accepted (docs/run-approval-bff-r9.md, section 2a): the
    // nonce is Threat-Model-A protection (foreign web origin / CSRF), not
    // Threat-Model-B protection (any local process as the same Windows
    // user). This is deliberate scope, not a defect - see that section for
    // why it matches Felix Core's existing local-trust model.
    assert.equal(response.status, 200, "Threat Model B is deliberately out of scope for R9 - see docs/run-approval-bff-r9.md section 2a. If this now fails, Threat Model B was closed by a later change and that doc section must be updated to match.");
    const body = await response.json();
    assert.ok(["queued", "running"].includes(body.status));
  });
});
