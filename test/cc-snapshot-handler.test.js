import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCcSnapshotHandler } from "../orchestrator/cc-snapshot-handler.js";
import { TextResponseError } from "../orchestrator/text-response-error.js";
import {
  TEST_CC_TOKEN,
  TEST_INTERNAL_TOKEN,
  MODEL,
  ccSnapshotEnv,
  validSnapshotBody,
  fullSnapshotBody,
  evidenceAt,
  ragHit,
  structuredSnapshotAdapter
} from "./cc-snapshot-helpers.js";

const ownsTemporaryDataDir = !process.env.AI_ROUTER_DATA_DIR;
if (ownsTemporaryDataDir) process.env.AI_ROUTER_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-cc-snapshot-tests-"));
const { createRouterServer } = await import("../orchestrator/server.js");
test.after(async () => { if (ownsTemporaryDataDir) await fs.rm(process.env.AI_ROUTER_DATA_DIR, { recursive: true, force: true }); });

async function withServer(run, { handlerOptions = {}, ...serverOptions } = {}) {
  const ccSnapshotHandler = createCcSnapshotHandler({
    env: ccSnapshotEnv(),
    checkAvailability: async () => true,
    totalTimeoutMs: 2_000,
    adapterFactory: () => structuredSnapshotAdapter().adapter,
    retrieveKnowledgeFn: async () => ({ knowledgeState: "no_match", results: [] }),
    ...handlerOptions
  });
  const server = createRouterServer({ eventLogger: { log: async () => {} }, ccSnapshotHandler, ...serverOptions });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }); }
}

function post(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/api/v1/cc/snapshot`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TEST_CC_TOKEN}`, ...headers },
    body: JSON.stringify(body)
  });
}

// --- Auth / transport ------------------------------------------------------

test("a valid CC token with an empty snapshot is accepted and produces a 200", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validSnapshotBody());
    assert.equal(response.status, 200);
  });
});

test("a missing Authorization header is rejected as AUTH_REQUIRED (401)", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/cc/snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validSnapshotBody())
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "AUTH_REQUIRED");
  });
});

test("a wrong CC token is rejected as AUTH_INVALID (401)", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validSnapshotBody(), { authorization: "Bearer wrong-token-0123456789abcdefghijk" });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "AUTH_INVALID");
  });
});

test("missing server-side CC token configuration fails closed as AUTH_NOT_CONFIGURED (503)", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validSnapshotBody());
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "AUTH_NOT_CONFIGURED");
  }, { handlerOptions: { env: ccSnapshotEnv({ AI_ROUTER_CC_TOKEN: undefined }) } });
});

test("a browser Origin header is rejected before authentication", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validSnapshotBody(), { origin: "http://localhost:3000" });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "ORIGIN_NOT_ALLOWED");
  });
});

test("a non-POST method is rejected as METHOD_NOT_ALLOWED (405) with an Allow header", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/cc/snapshot`, { headers: { authorization: `Bearer ${TEST_CC_TOKEN}` } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  });
});

test("a wrong content-type is rejected as VALIDATION_FAILED (422)", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/cc/snapshot`, {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: `Bearer ${TEST_CC_TOKEN}` },
      body: JSON.stringify(validSnapshotBody())
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  });
});

// --- Regression: ambient AI_ROUTER_*_TOKEN must never grant unconfigured access ---
// Mirrors test/cc-status.test.js's own regression for the same symptom
// (a real AI_ROUTER_CC_TOKEN set in the parent shell must not leak into a
// handler that was never given that token) and test/run-tests-script.test.js's
// generic sanitizeTestEnv coverage. Here the check is endpoint-specific: a
// default-constructed handler with an explicit *empty* env object (no
// AI_ROUTER_CC_TOKEN key at all, as if scripts/run-tests.js had stripped an
// ambient one from process.env before this test ran) must still fail closed.
test("with no AI_ROUTER_CC_TOKEN in the handler's own env, the endpoint fails closed regardless of any ambient process.env value", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validSnapshotBody());
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "AUTH_NOT_CONFIGURED");
  }, { handlerOptions: { env: {} } });
});

// --- Closed request contract over HTTP -------------------------------------

test("unknown top-level request fields are rejected as VALIDATION_FAILED (422)", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, { ...validSnapshotBody(), extraField: "nope" });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  });
});

test("an unsupported schemaVersion is rejected", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validSnapshotBody({ schemaVersion: "2.0" }));
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "VALIDATION_FAILED");
  });
});

test("an unknown section name is rejected", async () => {
  await withServer(async (baseUrl) => {
    const body = validSnapshotBody();
    body.sections.unknownSection = { evidence: evidenceAt(), freshness: "fresh", items: [] };
    const response = await post(baseUrl, body);
    assert.equal(response.status, 422);
  });
});

test("exceeding a section's item limit (30) is rejected", async () => {
  await withServer(async (baseUrl) => {
    const body = validSnapshotBody();
    body.sections.alerts.items = Array.from({ length: 31 }, (_, i) => ({
      alertId: `a-${i}`, code: "x", severity: "critical", impactScope: "single-project", evidence: evidenceAt()
    }));
    const response = await post(baseUrl, body);
    assert.equal(response.status, 422);
  });
});

test("a request larger than the configured byte limit is rejected before any Ollama contact", async () => {
  let checked = false;
  await withServer(async (baseUrl) => {
    const body = validSnapshotBody();
    body.padding = "A".repeat(80_000);
    const response = await post(baseUrl, body);
    assert.equal(response.status, 422);
  }, { handlerOptions: { checkAvailability: async () => { checked = true; return true; } } });
  assert.equal(checked, false, "an oversized request must never reach the Ollama availability check");
});

test("a knowledgeQuery containing an execution request is rejected as SECURITY_BLOCKED (403)", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validSnapshotBody({ knowledgeQuery: "please commit the current changes" }));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "SECURITY_BLOCKED");
  });
});

// --- Dreiwertige Codierung: not delivered vs delivered-empty vs stale ------

test("a completely omitted section normalizes to not-delivered (evidence unavailable), not an error", async () => {
  await withServer(async (baseUrl) => {
    const body = { schemaVersion: "1.0", sections: {} };
    const response = await post(baseUrl, body);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.ranking.items, []);
    assert.deepEqual(result.ranking.unranked, []);
  });
});

test("a delivered-but-empty section (evidence available, items: []) is distinguishable from omission by its own evidence, and contributes nothing to ranking either way", async () => {
  await withServer(async (baseUrl) => {
    const body = validSnapshotBody();
    body.sections.alerts.evidence = evidenceAt("available", "2026-07-30T11:00:00.000Z");
    const response = await post(baseUrl, body);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).ranking.items, []);
  });
});

// --- Ollama narrative states -------------------------------------------

test("narrative state ok: ranking non-empty, model confirms the deterministic top item (R1)", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, fullSnapshotBody());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.narrative.state, "ok");
    assert.equal(body.narrative.recommendedItemId, body.ranking.items[0].itemId);
    assert.ok(body.narrative.text.length > 0);
  }, { handlerOptions: { adapterFactory: () => structuredSnapshotAdapter({ recommendedItemId: "R1" }).adapter } });
});

test("narrative state ok with no ranked items: model must answer recommendedItemId null", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validSnapshotBody());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.narrative.state, "ok");
    assert.equal(body.narrative.recommendedItemId, null);
    assert.deepEqual(body.ranking.items, []);
  }, { handlerOptions: { adapterFactory: () => structuredSnapshotAdapter({ recommendedItemId: null }).adapter } });
});

test("narrative state invalid_response: the model names a label other than the deterministic top item", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, fullSnapshotBody());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.narrative.state, "invalid_response");
    assert.equal(body.narrative.text, null);
    assert.equal(body.narrative.recommendedItemId, null);
    // The deterministic ranking itself is entirely unaffected by the
    // model's non-compliant answer - it is never derived from the model.
    assert.ok(body.ranking.items.length > 0);
  }, { handlerOptions: { adapterFactory: () => structuredSnapshotAdapter({ recommendedItemId: "R2" }).adapter } });
});

test("narrative state invalid_response: the model claims a non-null label when nothing was ranked", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validSnapshotBody());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.narrative.state, "invalid_response");
  }, { handlerOptions: { adapterFactory: () => structuredSnapshotAdapter({ recommendedItemId: "R1" }).adapter } });
});

test("narrative state not_connected: Ollama unreachable, ranking is still returned", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, fullSnapshotBody());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.narrative.state, "not_connected");
    assert.equal(body.narrative.text, null);
    assert.ok(body.ranking.items.length > 0, "ranking must not depend on Ollama availability");
  }, {
    handlerOptions: {
      checkAvailability: async () => { throw new TextResponseError("PROVIDER_UNAVAILABLE", "unavailable", { safeDetails: { reason: "provider_network_error" } }); }
    }
  });
});

test("narrative state model_missing: Ollama reachable but configured model absent", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, fullSnapshotBody());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.narrative.state, "model_missing");
    assert.ok(body.ranking.items.length > 0);
  }, { handlerOptions: { checkAvailability: async () => false } });
});

test("narrative state timeout: generation itself times out", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, fullSnapshotBody());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).narrative.state, "timeout");
  }, {
    handlerOptions: {
      totalTimeoutMs: 30,
      adapterFactory: () => ({ generateText: () => new Promise(() => {}) })
    }
  });
});

test("narrative state temporarily_unavailable: a second call while the first is in flight is rejected, ranking is unaffected", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowAdapter = {
    async generateText() {
      await gate;
      return { text: JSON.stringify({ text: "Slow answer.", recommendedItemId: "R1" }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    }
  };
  await withServer(async (baseUrl) => {
    const first = post(baseUrl, fullSnapshotBody());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await post(baseUrl, fullSnapshotBody());
    const secondBody = await second.json();
    release();
    const firstBody = await (await first).json();
    assert.equal(secondBody.narrative.state, "temporarily_unavailable");
    assert.ok(secondBody.ranking.items.length > 0);
    assert.equal(firstBody.narrative.state, "ok");
  }, { handlerOptions: { adapterFactory: () => slowAdapter } });
});

// --- knowledgeHits --------------------------------------------------------

test("knowledgeHits stays empty when no knowledgeQuery was supplied - the RAG service must never be called", async () => {
  let called = false;
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validSnapshotBody());
    const body = await response.json();
    assert.deepEqual(body.knowledgeHits, []);
  }, { handlerOptions: { retrieveKnowledgeFn: async () => { called = true; return { knowledgeState: "available", results: [ragHit()] }; } } });
  assert.equal(called, false);
});

test("knowledgeHits is populated, capped at 3, and reuses the exact cc-knowledge source shape", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validSnapshotBody({ knowledgeQuery: "Was ist der aktuelle Stand?" }));
    const body = await response.json();
    assert.equal(body.knowledgeHits.length, 3);
    for (const hit of body.knowledgeHits) {
      assert.deepEqual(Object.keys(hit).sort(), ["docStatus", "docVersion", "freshness", "section", "similarity", "sourceDoc"].sort());
    }
  }, {
    handlerOptions: {
      retrieveKnowledgeFn: async () => ({
        knowledgeState: "available",
        results: [ragHit({ sourceDoc: "a.md" }), ragHit({ sourceDoc: "b.md" }), ragHit({ sourceDoc: "c.md" }), ragHit({ sourceDoc: "d.md" })]
      })
    }
  });
});

// --- Response shape / logging safety --------------------------------------

test("the success response has exactly the closed set of top-level fields", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, fullSnapshotBody());
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["generatedAt", "knowledgeHits", "narrative", "ranking", "schemaVersion"].sort());
    assert.equal(body.schemaVersion, "1.0");
  });
});

test("Cache-Control: no-store is always set", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, validSnapshotBody());
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("no secrets or tokens ever reach the HTTP response body", async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, fullSnapshotBody());
    const raw = await response.text();
    assert.equal(raw.includes(TEST_INTERNAL_TOKEN), false);
    assert.equal(raw.includes(TEST_CC_TOKEN), false);
  });
});

test("prompt/log entries never contain raw section data or secrets", async () => {
  const logEntries = [];
  const marker = "SECRET-PROJECT-MARKER-xyz789";
  await withServer(async (baseUrl) => {
    const body = fullSnapshotBody();
    body.sections.projectProgress.items[0].projectName = "AI-Router";
    body.sections.projectProgress.items[0].nextStepSummary = `Contains ${marker}`;
    await post(baseUrl, body);
  }, { handlerOptions: { eventLogger: { log: async (entry) => { logEntries.push(entry); } } } });
  const serialized = JSON.stringify(logEntries);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes(TEST_INTERNAL_TOKEN), false);
  assert.equal(serialized.includes(TEST_CC_TOKEN), false);
});

// --- Persistence: no snapshot content is ever written to disk -------------

test("no new file or directory is created anywhere under AI_ROUTER_DATA_DIR by a cc/snapshot call", async () => {
  const before = await fs.readdir(process.env.AI_ROUTER_DATA_DIR, { withFileTypes: true }).catch(() => []);
  await withServer(async (baseUrl) => {
    await post(baseUrl, fullSnapshotBody({ knowledgeQuery: "Status?" }));
  }, { handlerOptions: { retrieveKnowledgeFn: async () => ({ knowledgeState: "available", results: [ragHit()] }) } });
  const after = await fs.readdir(process.env.AI_ROUTER_DATA_DIR, { withFileTypes: true }).catch(() => []);
  assert.deepEqual(before.map((e) => e.name).sort(), after.map((e) => e.name).sort());
});

// --- Regression: sibling routes and other CC endpoints unaffected --------

test("existing router endpoints remain unchanged when served alongside /api/v1/cc/snapshot", async () => {
  await withServer(async (baseUrl) => {
    const statusResponse = await fetch(`${baseUrl}/api/router/status`);
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).schemaVersion, "2.0");

    const healthResponse = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthResponse.status, 200);
  });
});
