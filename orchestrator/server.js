import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, RECOMMENDATION_MAX_BODY_BYTES, REPOSITORY_ROOT, ROUTER_ALLOWED_ORIGINS, ROUTER_API_DEFAULT_MODE, ROUTER_API_MAX_BODY_BYTES, ROUTER_API_TIMEOUT_MS, ROUTER_VERSION } from "./config.js";
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
import { providerRegistry } from "./provider-registry.js";
import { previewProviderSelection } from "./provider-selection.js";
import { processRouterRequest, routerActions, routerStatus } from "./router-service.js";
import { safeRequestIdentity } from "./router-contract.js";
import { buildRouterFailure, routerHttpStatus } from "./router-response.js";
import { createRecommendations } from "./recommendation-engine.js";
import { buildRecommendationFailure, recommendationHttpStatus } from "./recommendation-response.js";
import { handleTextResponseRequest, handleProjectStatusRequest, handleGitChangeRequest } from "./text-response-handler.js";
import { handleCcStatusRequest } from "./cc-status-handler.js";
import { handleRouterConsoleRespond } from "./router-console-proxy.js";

const uiFile = path.join(REPOSITORY_ROOT, "01_APP", "tests", "ai-router-v0_13-test.html");
const routerConsoleUiFile = path.join(REPOSITORY_ROOT, "01_APP", "router-console.html");

function isAllowedRouterOrigin(origin, allowedOrigins) {
  return typeof origin === "string" && allowedOrigins.includes(origin);
}

function applyRouterCors(request, response, allowedOrigins) {
  const origin = request.headers.origin;
  if (isAllowedRouterOrigin(origin, allowedOrigins)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    response.setHeader("access-control-allow-headers", "Content-Type");
    response.setHeader("access-control-max-age", "600");
  }
}

function isTrustedMutation(request) {
  const origin = request.headers.origin;
  const contentType = request.headers["content-type"] || "";
  return (!origin || origin === "http://127.0.0.1:8787") && contentType.toLowerCase().startsWith("application/json");
}

function isTrustedRouterRequest(request, allowedOrigins) {
  const origin = request.headers.origin;
  return !origin || isAllowedRouterOrigin(origin, allowedOrigins);
}

function isTrustedRouterMutation(request, allowedOrigins) {
  const contentType = request.headers["content-type"] || "";
  return isTrustedRouterRequest(request, allowedOrigins) && contentType.toLowerCase().startsWith("application/json");
}

function safeFilterValue(value, allowed, maximum = 40) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, maximum);
  if (!cleaned) return null;
  if (allowed && !allowed.includes(cleaned)) return null;
  return cleaned;
}

function isoOrNull(value) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; }

export function createRouterServer({ service = new RunService(), eventLogger = logger, allowedRouterOrigins = ROUTER_ALLOWED_ORIGINS, routerTimeoutMs = ROUTER_API_TIMEOUT_MS, routerProcessor = processRouterRequest, textResponseHandler = handleTextResponseRequest, projectStatusHandler = handleProjectStatusRequest, gitChangeHandler = handleGitChangeRequest, ccStatusHandler = handleCcStatusRequest, routerConsoleRespondHandler = handleRouterConsoleRespond, now = Date.now } = {}) {
  const serverStartedAt = Date.now();
  const safeLog = (event, safeMetadata = {}) => {
    try { Promise.resolve(eventLogger?.log?.({ event, safeMetadata })).catch(() => {}); } catch { /* logging is non-critical */ }
  };
  const buildHealth = async () => {
    service.adapterStatus.refresh().catch(() => {});
    const [storage, logging] = await Promise.all([storageHealth(), loggingHealth()]);
    return buildHealthStatus({ snapshot: service.snapshot(), adapterStatus: service.adapterStatus.current(), storage, logging, providers: service.registry.status(), startedAt: serverStartedAt });
  };
  const buildDiagnosticsPayload = async () => {
    service.adapterStatus.refresh().catch(() => {});
    const [history, storage, logging] = await Promise.all([historySnapshot(), storageHealth(), loggingHealth()]);
    return buildDiagnostics({ history, adapterStatus: service.adapterStatus.current(), storage, logging });
  };

  const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const { pathname } = url;
    const isRouterPath = pathname.startsWith("/api/router/");

    if (pathname === "/api/router/respond") return textResponseHandler(request, response);

    if (pathname === "/api/router/project-status") return projectStatusHandler(request, response);

    if (pathname === "/api/router/git-changes") return gitChangeHandler(request, response);

    if (pathname === "/api/v1/cc/status") return ccStatusHandler(request, response);

    if (isRouterPath) {
      if (!isTrustedRouterRequest(request, allowedRouterOrigins)) {
        const error = new RouterError("ORIGIN_NOT_ALLOWED", "Origin is not allowed.");
        const payload = pathname === "/api/router/recommendations" ? buildRecommendationFailure(error) : buildRouterFailure(error);
        return sendJson(response, pathname === "/api/router/recommendations" ? recommendationHttpStatus(payload) : routerHttpStatus(payload.error.code), payload);
      }
      applyRouterCors(request, response, allowedRouterOrigins);
      if (request.method === "OPTIONS") { response.writeHead(204); return response.end(); }
    }

    if (request.method === "GET" && pathname === "/") return sendText(response, 200, await fs.readFile(uiFile, "utf8"), "text/html; charset=utf-8");

    if (request.method === "GET" && pathname === "/router-console") return sendText(response, 200, await fs.readFile(routerConsoleUiFile, "utf8"), "text/html; charset=utf-8");

    if (request.method === "POST" && pathname === "/api/router-console/respond") {
      if (!isTrustedMutation(request)) return sendJson(response, 403, { code: "INVALID_REQUEST", message: "Untrusted local request." });
      return routerConsoleRespondHandler(request, response);
    }

    if (request.method === "GET" && pathname === "/api/health") { safeLog("health_checked"); return sendJson(response, 200, await buildHealth()); }

    if (request.method === "GET" && pathname === "/api/diagnostics") { safeLog("diagnostics_checked"); return sendJson(response, 200, await buildDiagnosticsPayload()); }

    if (request.method === "GET" && pathname === "/api/cockpit-status") return sendJson(response, 200, projectCockpitStatus(service.cockpitContext()));

    if (request.method === "GET" && pathname === "/api/router/status") return sendJson(response, 200, routerStatus());

    if (request.method === "GET" && pathname === "/api/router/actions") return sendJson(response, 200, routerActions());

    if (request.method === "POST" && pathname === "/api/router/recommendations") {
      if (!isTrustedRouterMutation(request, allowedRouterOrigins)) {
        const payload = buildRecommendationFailure(new RouterError("INVALID_REQUEST", "Content-Type must be application/json."));
        return sendJson(response, recommendationHttpStatus(payload), payload);
      }
      try {
        const input = await readJsonBody(request, RECOMMENDATION_MAX_BODY_BYTES);
        const payload = createRecommendations(input);
        safeLog("recommendation_generated", {
          projectId: payload.recommendation?.projectId || null,
          recommendationPresent: payload.recommendation !== null,
          reasonCode: payload.recommendation?.reasonCodes?.[0] || payload.blockedReasons[0] || null,
          mode: payload.mode
        });
        return sendJson(response, 200, payload);
      } catch (error) {
        const payload = buildRecommendationFailure(error);
        safeLog("recommendation_rejected", { errorCode: payload.error.code, mode: payload.mode });
        return sendJson(response, recommendationHttpStatus(payload), payload);
      }
    }

    if (request.method === "POST" && pathname === "/api/router/route") {
      if (!isTrustedRouterMutation(request, allowedRouterOrigins)) {
        const payload = buildRouterFailure(new RouterError("INVALID_REQUEST", "Content-Type must be application/json."));
        return sendJson(response, routerHttpStatus(payload.error.code), payload);
      }
      const startedAt = now();
      const abortController = new AbortController();
      let identity = { requestId: null, mode: ROUTER_API_DEFAULT_MODE };
      let timer;
      try {
        const operation = (async () => {
          const input = await readJsonBody(request, ROUTER_API_MAX_BODY_BYTES, { signal: abortController.signal });
          identity = safeRequestIdentity(input);
          return routerProcessor(input, { eventLogger });
        })().catch((error) => buildRouterFailure(error, { ...identity, durationMs: Math.max(0, now() - startedAt) }));
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => {
            response.setHeader("connection", "close");
            abortController.abort();
            resolve(buildRouterFailure(new RouterError("TIMEOUT", "Router request timed out."), { ...identity, durationMs: Math.max(1, now() - startedAt) }));
          }, routerTimeoutMs);
        });
        const payload = await Promise.race([operation, timeout]);
        return sendJson(response, payload.error ? routerHttpStatus(payload.error.code) : 200, payload);
      } finally {
        clearTimeout(timer);
        abortController.abort();
      }
    }

    if (request.method === "GET" && pathname === "/api/providers") {
      safeLog("providers_listed");
      const registryStatus = service.registry.status();
      return sendJson(response, 200, { schemaVersion: SCHEMA_VERSION, providerRegistryStatus: registryStatus.registryStatus, providers: service.registry.publicList() });
    }

    const providerDetail = pathname.match(/^\/api\/providers\/([^/]+)$/);
    if (request.method === "GET" && providerDetail) {
      const provider = service.registry.publicGet(decodeURIComponent(providerDetail[1]));
      if (!provider) return sendJson(response, 404, errorPayload(new RouterError("PROVIDER_NOT_FOUND", "Provider not found.")));
      safeLog("provider_details_viewed", { providerId: provider.providerId });
      return sendJson(response, 200, { schemaVersion: SCHEMA_VERSION, provider });
    }

    if (request.method === "POST" && pathname === "/api/providers/select") {
      if (!isTrustedMutation(request)) return sendJson(response, 403, { code: "INVALID_REQUEST", message: "Untrusted local request." });
      try {
        const preview = previewProviderSelection(await readJsonBody(request), service.registry);
        safeLog("provider_selection_previewed", { providerId: preview.selectedProviderId });
        return sendJson(response, 200, { schemaVersion: SCHEMA_VERSION, provider: preview });
      } catch (error) { return sendJson(response, 400, errorPayload(error)); }
    }

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
  server.requestTimeout = 130_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const server = createRouterServer();
  server.listen(8787, "127.0.0.1", () => { logger.log({ event: "server_started", safeMetadata: { version: ROUTER_VERSION } }).catch(() => {}); console.log("AI Router local server: http://127.0.0.1:8787"); });
  process.once("SIGINT", () => { logger.log({ event: "server_stopped" }).catch(() => {}); server.close(() => process.exit(0)); });
}
