import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ownsTemporaryDataDir = !process.env.AI_ROUTER_DATA_DIR;
if (ownsTemporaryDataDir) process.env.AI_ROUTER_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "ai-router-console-tests-"));
const { createRouterServer } = await import("../orchestrator/server.js");
const { createTextResponseHandler } = await import("../orchestrator/text-response-handler.js");
const { createRouterConsoleRespondHandler } = await import("../orchestrator/router-console-proxy.js");
const { successfulAdapter, textProviderEnv } = await import("./text-response-helpers.js");

test.after(async () => { if (ownsTemporaryDataDir) await fs.rm(process.env.AI_ROUTER_DATA_DIR, { recursive: true, force: true }); });

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyUiFile = path.join(repositoryRoot, "01_APP", "tests", "ai-router-v0_13-test.html");
const consoleUiFile = path.join(repositoryRoot, "01_APP", "router-console.html");

async function withServer(run, options = {}) {
  const server = createRouterServer({ eventLogger: { log: async () => {} }, ...options });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }); }
}

function consoleHandlerWithAdapter({ adapter, env = textProviderEnv() } = {}) {
  const fallback = successfulAdapter();
  const selectedAdapter = adapter || fallback.adapter;
  const textResponseHandler = createTextResponseHandler({ env, adapterFactory: () => selectedAdapter });
  return createRouterConsoleRespondHandler({ env, textResponseHandler });
}

test("GET / still serves the untouched legacy simulation UI, unchanged apart from its R9 approval nonce", async () => {
  const template = await fs.readFile(legacyUiFile, "utf8");
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    const body = await response.text();
    const match = /name="approval-nonce" content="([0-9a-f]{64})"/.exec(body);
    assert.ok(match, "served page must embed a hex approval nonce");
    assert.equal(body, template.replace("__APPROVAL_NONCE__", match[1]));
  });
});

test("GET /router-console serves the new, separate console page", async () => {
  const expected = await fs.readFile(consoleUiFile, "utf8");
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/router-console`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    const body = await response.text();
    assert.equal(body, expected);
    assert.match(body, /Router-Konsole/);
  });
});

test("the console page is a distinct file from the legacy simulation UI", async () => {
  const legacy = await fs.readFile(legacyUiFile, "utf8");
  const consoleUi = await fs.readFile(consoleUiFile, "utf8");
  assert.notEqual(legacy, consoleUi);
});

test("POST /api/router-console/respond forwards a real answer through the unmodified /api/router/respond pipeline", async () => {
  const { adapter, calls } = successfulAdapter({ text: "Berlin ist die Hauptstadt von Deutschland." });
  const routerConsoleRespondHandler = consoleHandlerWithAdapter({ adapter });
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router-console/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Was ist die Hauptstadt von Deutschland?" })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.status, "answered");
    assert.equal(payload.answer.text, "Berlin ist die Hauptstadt von Deutschland.");
    assert.equal(payload.provider.providerId, "openai-text-v1");
    assert.ok(typeof payload.meta.durationMs === "number");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].question, "Was ist die Hauptstadt von Deutschland?");
    assert.equal(payload.consoleDiagnostics.selectedProviderId, "openai-text-v1");
    assert.equal(typeof payload.consoleDiagnostics.routeName, "string");
    assert.equal(typeof payload.consoleDiagnostics.taskType, "string");
    assert.equal(payload.consoleDiagnostics.validationReasonCode, null);
  }, { routerConsoleRespondHandler });
});

test("POST /api/router-console/respond surfaces a genuine VALIDATION_FAILED for an empty question", async () => {
  const routerConsoleRespondHandler = consoleHandlerWithAdapter();
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router-console/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "" })
    });
    assert.equal(response.status, 422);
    const payload = await response.json();
    assert.equal(payload.status, "failed");
    assert.equal(payload.error.code, "VALIDATION_FAILED");
    assert.deepEqual(payload.consoleDiagnostics, {
      selectedProviderId: null, routeName: null, taskType: null, validationReasonCode: null
    });
  }, { routerConsoleRespondHandler });
});

test("POST /api/router-console/respond surfaces a genuine INPUT_TOO_LARGE for an over-limit question", async () => {
  const routerConsoleRespondHandler = consoleHandlerWithAdapter();
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router-console/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "A".repeat(8001) })
    });
    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.equal(payload.status, "failed");
    assert.equal(payload.error.code, "INPUT_TOO_LARGE");
  }, { routerConsoleRespondHandler });
});

test("POST /api/router-console/respond rejects requests from an untrusted origin", async () => {
  const routerConsoleRespondHandler = consoleHandlerWithAdapter();
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router-console/respond`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ question: "Hallo" })
    });
    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.code, "INVALID_REQUEST");
  }, { routerConsoleRespondHandler });
});

test("consoleDiagnostics is added as the only extra field; every upstream field stays byte-identical", async () => {
  const { adapter } = successfulAdapter({ text: "Antwort." });
  const env = textProviderEnv();
  let capturedPayload = null;
  const baseHandler = createTextResponseHandler({ env, adapterFactory: () => adapter });
  const textResponseHandler = async (req, res) => {
    capturedPayload = await baseHandler(req, res);
    return capturedPayload;
  };
  const routerConsoleRespondHandler = createRouterConsoleRespondHandler({ env, textResponseHandler });
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router-console/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Test" })
    });
    const payload = await response.json();
    assert.ok(capturedPayload, "the upstream handler must have been called");
    for (const key of Object.keys(capturedPayload)) {
      assert.deepEqual(payload[key], capturedPayload[key], `upstream field "${key}" changed`);
    }
    assert.equal(Object.keys(payload).length, Object.keys(capturedPayload).length + 1);
    assert.ok("consoleDiagnostics" in payload);
    assert.equal("consoleDiagnostics" in capturedPayload, false);
  }, { routerConsoleRespondHandler });
});

test("the console proxy never leaks the internal bearer token to the browser-facing response", async () => {
  const env = textProviderEnv({ AI_ROUTER_INTERNAL_TOKEN: "console-proxy-secret-token-0123456789abcdef" });
  const routerConsoleRespondHandler = consoleHandlerWithAdapter({ env });
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/router-console/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Hallo" })
    });
    const raw = await response.text();
    assert.equal(raw.includes("console-proxy-secret-token-0123456789abcdef"), false);
  }, { routerConsoleRespondHandler });
});
