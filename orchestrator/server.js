import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, REPOSITORY_ROOT, ROUTER_VERSION } from "./config.js";
import { RunService } from "./run-service.js";
import { getRunSummary, historySnapshot, listRuns, loadLatestRun, storageHealth } from "./run-store.js";
import { projectCockpitStatus } from "./cockpit-status.js";
import { buildHealthStatus } from "./health.js";
import { buildDiagnostics } from "./diagnostics.js";
import { logger, loggingHealth } from "./logger.js";
import { readJsonBody, sendJson, sendText } from "./http-utils.js";
import { buildResponse, errorPayload } from "./response-builder.js";
import { RouterError } from "./contracts.js";
import { ALLOWED_ADAPTERS, ALLOWED_RUN_STATUSES, SCHEMA_VERSION } from "./policy.js";

const service = new RunService();
const SERVER_STARTED_AT = Date.now();
const uiFile = path.join(REPOSITORY_ROOT, "01_APP", "tests", "ai-router-v0_12-test.html");

// Fire-and-forget safe logging: operational events must never break a request.
function safeLog(event, safeMetadata = {}) { logger.log({ event, safeMetadata }).catch(() => {}); }

function isTrustedMutation(request) {
  const origin = request.headers.origin;
  const contentType = request.headers["content-type"] || "";
  return (!origin || origin === "http://127.0.0.1:8787") && contentType.toLowerCase().startsWith("application/json");
}

function safeFilterValue(value, allowed, maximum = 40) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, maximum);
  if (!cleaned) return null;
  if (allowed && !allowed.includes(cleaned)) return null;
  return cleaned;
}

function isoOrNull(value) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; }

async function buildHealth() {
  service.adapterStatus.refresh().catch(() => {});
  const [storage, logging] = await Promise.all([storageHealth(), loggingHealth()]);
  return buildHealthStatus({ snapshot: service.snapshot(), adapterStatus: service.adapterStatus.current(), storage, logging, startedAt: SERVER_STARTED_AT });
}

async function buildDiagnosticsPayload() {
  service.adapterStatus.refresh().catch(() => {});
  const [history, storage, logging] = await Promise.all([historySnapshot(), storageHealth(), loggingHealth()]);
  return buildDiagnostics({ history, adapterStatus: service.adapterStatus.current(), storage, logging });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/") return sendText(response, 200, await fs.readFile(uiFile, "utf8"), "text/html; charset=utf-8");

    if (request.method === "GET" && pathname === "/api/health") { safeLog("health_checked"); return sendJson(response, 200, await buildHealth()); }

    if (request.method === "GET" && pathname === "/api/diagnostics") { safeLog("diagnostics_checked"); return sendJson(response, 200, await buildDiagnosticsPayload()); }

    if (request.method === "GET" && pathname === "/api/cockpit-status") return sendJson(response, 200, projectCockpitStatus(service.cockpitContext()));

    if (request.method === "POST" && pathname === "/api/adapters/check") {
      if (!isTrustedMutation(request)) return sendJson(response, 403, { code: "INVALID_REQUEST", message: "Untrusted local request." });
      safeLog("adapter_check_started");
      try {
        const status = await service.adapterStatus.refresh({ force: true });
        safeLog("adapter_check_completed", { codex: status["codex-cli"].state, mock: status.mock.state });
        return sendJson(response, 200, { schemaVersion: SCHEMA_VERSION, adapterStatus: status });
      } catch {
        safeLog("adapter_check_failed");
        return sendJson(response, 200, { schemaVersion: SCHEMA_VERSION, adapterStatus: service.adapterStatus.current() });
      }
    }

    if (request.method === "GET" && pathname === "/api/history") {
      const status = safeFilterValue(url.searchParams.get("status"), ALLOWED_RUN_STATUSES);
      const adapter = safeFilterValue(url.searchParams.get("adapter"), ALLOWED_ADAPTERS);
      const since = isoOrNull(url.searchParams.get("since"));
      const until = isoOrNull(url.searchParams.get("until"));
      const limit = Number(url.searchParams.get("limit")) || DEFAULT_HISTORY_LIMIT;
      const offset = Number(url.searchParams.get("offset")) || 0;
      const page = await listRuns({ limit: Math.min(limit, MAX_HISTORY_LIMIT), offset, status, adapter, since, until });
      safeLog("run_listed", { count: String(page.runs.length) });
      return sendJson(response, 200, { schemaVersion: SCHEMA_VERSION, ...page });
    }

    const historyDetail = pathname.match(/^\/api\/history\/([^/]+)$/);
    if (request.method === "GET" && historyDetail) {
      const summary = await getRunSummary(decodeURIComponent(historyDetail[1]));
      if (!summary) return sendJson(response, 404, errorPayload(new RouterError("RUN_NOT_FOUND", "Run not found.")));
      safeLog("run_details_viewed");
      return sendJson(response, 200, { schemaVersion: SCHEMA_VERSION, run: summary });
    }

    if (request.method === "POST" && pathname === "/api/runs") {
      if (!isTrustedMutation(request)) return sendJson(response, 403, buildResponse(null, new RouterError("INVALID_REQUEST", "Untrusted local request.")));
      return sendJson(response, 202, buildResponse(await service.create(await readJsonBody(request))));
    }

    if (request.method === "GET" && pathname === "/api/runs/latest") return sendJson(response, 200, buildResponse(await loadLatestRun()));

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (request.method === "GET" && runMatch) { const run = service.get(runMatch[1]); return sendJson(response, 200, buildResponse(run, run ? null : new RouterError("RUN_NOT_FOUND", "Run not found."))); }

    const cancelMatch = pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      if (!isTrustedMutation(request)) return sendJson(response, 403, buildResponse(null, new RouterError("INVALID_REQUEST", "Untrusted local request.")));
      const run = await service.cancel(cancelMatch[1]);
      return run ? sendJson(response, 200, buildResponse(run)) : sendJson(response, 409, buildResponse(null, new RouterError("RUN_ALREADY_FINISHED", "Run cannot be cancelled.")));
    }

    const approvalMatch = pathname.match(/^\/api\/runs\/([^/]+)\/approval$/);
    if (request.method === "POST" && approvalMatch) {
      if (!isTrustedMutation(request)) return sendJson(response, 403, buildResponse(null, new RouterError("INVALID_REQUEST", "Untrusted local request.")));
      return sendJson(response, 200, buildResponse(await service.decideApproval(approvalMatch[1], await readJsonBody(request))));
    }

    return sendJson(response, 404, buildResponse(null, new RouterError("INVALID_REQUEST", "Not found.")));
  } catch (error) { return sendJson(response, 400, buildResponse(null, error)); }
});

server.listen(8787, "127.0.0.1", () => { safeLog("server_started", { version: ROUTER_VERSION }); console.log("AI Router local server: http://127.0.0.1:8787"); });
process.once("SIGINT", () => { safeLog("server_stopped"); server.close(() => process.exit(0)); });
