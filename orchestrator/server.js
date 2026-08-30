import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTION_APPROVAL_MAX_EXECUTIONS_PER_WINDOW, ACTION_APPROVAL_RATE_WINDOW_MS, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, RECOMMENDATION_MAX_BODY_BYTES, REPOSITORY_ROOT, ROUTER_ALLOWED_ORIGINS, ROUTER_API_DEFAULT_MODE, ROUTER_API_MAX_BODY_BYTES, ROUTER_API_TIMEOUT_MS, ROUTER_VERSION } from "./config.js";
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
import { handleCcSummaryRequest } from "./cc-summary-handler.js";
import { handleCcKnowledgeRequest } from "./cc-knowledge-handler.js";
import { handleKnowledgeRequest } from "./knowledge-handler.js";
import { handleCcSnapshotRequest } from "./cc-snapshot-handler.js";
import { handleCcReindexRequest } from "./cc-reindex-handler.js";
import { handleRouterConsoleRespond } from "./router-console-proxy.js";
import { handleJarvisConsoleAsk } from "./jarvis-console-proxy.js";
import { actionApprovalService } from "./action/action-approval-service.js";
import { authenticateInternalRequest } from "./internal-auth.js";
import { approvalNonceStore } from "./approval-nonce-store.js";
import { createRateLimiter } from "./rate-limiter.js";
import { handleJarvisTranscribeRequest } from "./jarvis-transcribe-handler.js";
import { handleJarvisSpeakRequest } from "./jarvis-speak-handler.js";
import { checkJarvisReadiness } from "./jarvis-readiness.js";
import { handleJarvisToday } from "./jarvis-today-handler.js";
import { handleJarvisSystem } from "./jarvis-system-handler.js";
import { handleJarvisSessionStatus } from "./jarvis-session-status-handler.js";
import { handleJarvisSessionSummary } from "./jarvis-session-summary-handler.js";
import { handleJarvisVoiceStatus } from "./jarvis-voice-status-handler.js";
import { planJarvisRequest } from "./jarvis/request-planner.js";
import { dispatchJarvisRun, safeJarvisPlanView, buildJarvisRunResult } from "./jarvis/run-dispatcher.js";
import { sessionStore } from "./session/session-store.js";
import { buildSessionContext } from "./session/session-context.js";

const uiFile = path.join(REPOSITORY_ROOT, "01_APP", "tests", "ai-router-v0_13-test.html");
const routerConsoleUiFile = path.join(REPOSITORY_ROOT, "01_APP", "router-console.html");
const jarvisConsoleUiFile = path.join(REPOSITORY_ROOT, "01_APP", "jarvis-console.html");

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

// Both hostnames resolve to the same loopback server on the same machine -
// "localhost" and "127.0.0.1" are not different origins in any security
// sense here, only two names a browser can load this same local page from.
// Fixed 2026-08-15: the page is opened at http://localhost:8787/jarvis,
// which the browser's fetch() then sends as Origin on every mutation
// (including same-origin POSTs, standard fetch behaviour) - the previous
// 127.0.0.1-only check rejected that with a 403 on every voice endpoint.
const LOCAL_TRUSTED_ORIGINS = new Set(["http://127.0.0.1:8787", "http://localhost:8787"]);

function isTrustedMutation(request) {
  const origin = request.headers.origin;
  const contentType = request.headers["content-type"] || "";
  return (!origin || LOCAL_TRUSTED_ORIGINS.has(origin)) && contentType.toLowerCase().startsWith("application/json");
}

// Same same-origin rule as isTrustedMutation, but for the audio body the
// transcribe route accepts instead of JSON.
function isTrustedAudioMutation(request) {
  const origin = request.headers.origin;
  const contentType = request.headers["content-type"] || "";
  return (!origin || LOCAL_TRUSTED_ORIGINS.has(origin)) && contentType.toLowerCase().startsWith("audio/");
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

export function createRouterServer({ service = new RunService(), eventLogger = logger, allowedRouterOrigins = ROUTER_ALLOWED_ORIGINS, routerTimeoutMs = ROUTER_API_TIMEOUT_MS, routerProcessor = processRouterRequest, textResponseHandler = handleTextResponseRequest, projectStatusHandler = handleProjectStatusRequest, gitChangeHandler = handleGitChangeRequest, ccStatusHandler = handleCcStatusRequest, ccSummaryHandler = handleCcSummaryRequest, ccKnowledgeHandler = handleCcKnowledgeRequest, knowledgeHandler = handleKnowledgeRequest, ccSnapshotHandler = handleCcSnapshotRequest, ccReindexHandler = handleCcReindexRequest, routerConsoleRespondHandler = handleRouterConsoleRespond, jarvisConsoleAskHandler = handleJarvisConsoleAsk, jarvisTranscribeHandler = handleJarvisTranscribeRequest, jarvisSpeakHandler = handleJarvisSpeakRequest, jarvisTodayHandler = handleJarvisToday, jarvisSystemHandler = handleJarvisSystem, jarvisSessionStatusHandler = handleJarvisSessionStatus, jarvisSessionSummaryHandler = handleJarvisSessionSummary, jarvisVoiceStatusHandler = handleJarvisVoiceStatus, now = Date.now, timingSafeEqualFn } = {}) {
  const serverStartedAt = Date.now();
  const safeLog = (event, safeMetadata = {}) => {
    try { Promise.resolve(eventLogger?.log?.({ event, safeMetadata })).catch(() => {}); } catch { /* logging is non-critical */ }
  };
  // R7 - Approval Source Hardening + Action Rate Limit. One shared limiter
  // per server instance (not per request) - built lazily so `now` (test
  // clock injection) is captured at first use, same pattern as
  // cc-reindex-handler.js's protectionState().
  let actionApprovalRateLimiterInstance = null;
  const actionApprovalRateLimiter = () => {
    if (!actionApprovalRateLimiterInstance) {
      actionApprovalRateLimiterInstance = createRateLimiter({
        maximum: ACTION_APPROVAL_MAX_EXECUTIONS_PER_WINDOW,
        windowMs: ACTION_APPROVAL_RATE_WINDOW_MS,
        now
      });
    }
    return actionApprovalRateLimiterInstance;
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

    if (pathname === "/api/v1/cc/summary") return ccSummaryHandler(request, response);

    if (pathname === "/api/v1/cc/knowledge") return ccKnowledgeHandler(request, response);

    // Generic, read-only knowledge route. Same answering engine as the CC
    // route above, but its own token and its own rate budget - the CC
    // contract is deliberately left unmigrated and unchanged.
    if (pathname === "/api/v1/knowledge") return knowledgeHandler(request, response);

    if (pathname === "/api/v1/cc/snapshot") return ccSnapshotHandler(request, response);

    if (pathname === "/api/v1/cc/reindex") return ccReindexHandler(request, response);

    if (isRouterPath) {
      if (!isTrustedRouterRequest(request, allowedRouterOrigins)) {
        const error = new RouterError("ORIGIN_NOT_ALLOWED", "Origin is not allowed.");
        const payload = pathname === "/api/router/recommendations" ? buildRecommendationFailure(error) : buildRouterFailure(error);
        return sendJson(response, pathname === "/api/router/recommendations" ? recommendationHttpStatus(payload) : routerHttpStatus(payload.error.code), payload);
      }
      applyRouterCors(request, response, allowedRouterOrigins);
      if (request.method === "OPTIONS") { response.writeHead(204); return response.end(); }
    }

    // R9 - Run-Approval BFF. The nonce embedded here is the browser trust
    // boundary for POST /api/runs/:id/approval/ui below - see
    // approval-nonce-store.js's header for why this, not a cookie, and
    // docs/run-approval-bff-r9.md for the full design. A fresh nonce every
    // GET / is intentional: reloading the page is exactly the "prove you're
    // a browser that just loaded this server's own page" step.
    if (request.method === "GET" && pathname === "/") return sendText(response, 200, (await fs.readFile(uiFile, "utf8")).replace("__APPROVAL_NONCE__", approvalNonceStore.issue()), "text/html; charset=utf-8");

    if (request.method === "GET" && pathname === "/router-console") return sendText(response, 200, await fs.readFile(routerConsoleUiFile, "utf8"), "text/html; charset=utf-8");

    // U3 - same nonce injection as GET / above, now also for /jarvis: the
    // Jarvis console's run/approval panel reuses the existing R9 BFF route
    // (POST /api/runs/:id/approval/ui) and that route requires this nonce.
    // No new trust boundary - same approvalNonceStore, same single-use
    // semantics, just also embedded into this page.
    if (request.method === "GET" && pathname === "/jarvis") return sendText(response, 200, (await fs.readFile(jarvisConsoleUiFile, "utf8")).replace("__APPROVAL_NONCE__", approvalNonceStore.issue()), "text/html; charset=utf-8");

    // Server-side bridge for the Jarvis page. /api/v1/knowledge refuses any
    // browser Origin and needs a bearer token, so the page cannot call it
    // directly - the token stays in the server environment and never
    // reaches a browser. Same-origin guard as the router console.
    if (request.method === "POST" && pathname === "/api/jarvis/ask") {
      if (!isTrustedMutation(request)) return sendJson(response, 403, { code: "INVALID_REQUEST", message: "Untrusted local request." });
      return jarvisConsoleAskHandler(request, response);
    }

    // Local-only speech-to-text for the /jarvis page's question field. Same
    // same-origin discipline as /api/jarvis/ask; carries no knowledge token
    // and never touches the vault or the RAG index - it only turns audio
    // into text for the page to put in its own textarea.
    if (request.method === "POST" && pathname === "/api/jarvis/transcribe") {
      if (!isTrustedAudioMutation(request)) return sendJson(response, 403, { code: "INVALID_REQUEST", message: "Untrusted local request." });
      return jarvisTranscribeHandler(request, response);
    }

    // Local-only text-to-speech for the /jarvis page's "Vorlesen" button.
    // Same same-origin discipline as the other two /api/jarvis/* routes.
    // JSON body ({text}), so the JSON-content-type guard applies here, not
    // the audio one.
    if (request.method === "POST" && pathname === "/api/jarvis/speak") {
      if (!isTrustedMutation(request)) return sendJson(response, 403, { code: "INVALID_REQUEST", message: "Untrusted local request." });
      return jarvisSpeakHandler(request, response);
    }

    if (request.method === "POST" && pathname === "/api/router-console/respond") {
      if (!isTrustedMutation(request)) return sendJson(response, 403, { code: "INVALID_REQUEST", message: "Untrusted local request." });
      return routerConsoleRespondHandler(request, response);
    }

    if (request.method === "GET" && pathname === "/api/health") { safeLog("health_checked"); return sendJson(response, 200, await buildHealth()); }

    if (request.method === "GET" && pathname === "/api/diagnostics") { safeLog("diagnostics_checked"); return sendJson(response, 200, await buildDiagnosticsPayload()); }

    // Read-only, no token: same trust level as /api/health. Answers "can
    // Jarvis actually be used right now" before a real request is made -
    // see orchestrator/jarvis-readiness.js for what it does and does not
    // check (P2-A).
    if (request.method === "GET" && pathname === "/api/jarvis/ready") { safeLog("jarvis_ready_checked"); return sendJson(response, 200, await checkJarvisReadiness()); }

    // Read-only, no token: same trust level as /api/jarvis/ready. Proactive
    // counterpart to the reactive operational-context path inside
    // /api/jarvis/ask (DEC-007) - DEC-010 Phase 4A. No new data source: see
    // orchestrator/jarvis-today-handler.js for the exact reused functions.
    if (request.method === "GET" && pathname === "/api/jarvis/today") { safeLog("jarvis_today_checked"); return jarvisTodayHandler(request, response); }

    // Read-only, no token: same trust level as /api/jarvis/today. DEC-010
    // Phase 4B - reads only Command Center's already-scoped companion
    // contract (GET /api/companion/status), see
    // orchestrator/command-center-client.js. No new status logic here.
    if (request.method === "GET" && pathname === "/api/jarvis/system") { safeLog("jarvis_system_checked"); return jarvisSystemHandler(request, response); }

    // Read-only, no token, local diagnostic only (R1, Session/Context
    // Manager) - counts and the closed limit set, never session content
    // (see jarvis-session-status-handler.js).
    if (request.method === "GET" && pathname === "/api/jarvis/session-status") { safeLog("jarvis_session_status_checked"); return jarvisSessionStatusHandler(request, response); }

    // Same-origin gate as /api/jarvis/ask (M2, Session Summary Layer): the
    // sessionId in the body is the same value already trusted there, and
    // the returned content is exactly what that session already exchanged
    // over that same route - see jarvis-session-summary-handler.js.
    if (request.method === "POST" && pathname === "/api/jarvis/session/summary") {
      if (!isTrustedMutation(request)) return sendJson(response, 403, { code: "INVALID_REQUEST", message: "Untrusted local request." });
      safeLog("jarvis_session_summary_requested");
      return jarvisSessionSummaryHandler(request, response);
    }

    // Read-only, no token: same trust level as /api/jarvis/ready. Separate
    // route on purpose - see orchestrator/jarvis-voice-status.js for why
    // the actual Whisper reachability ping deliberately lives here and not
    // inside /api/jarvis/ready.
    if (request.method === "GET" && pathname === "/api/jarvis/voice-status") { safeLog("jarvis_voice_status_checked"); return jarvisVoiceStatusHandler(request, response); }

    // J1.2 - Jarvis Run Dispatcher (2026-08-29 handoff). Additive route, NOT
    // a change to /api/jarvis/ask: that route's own intent classification
    // (R2) has no code_analysis/code_implementation concept, and folding
    // this in would mean refactoring an already heavily audited path for a
    // small, additive vertical slice. This route turns a free-text question
    // into a J1.1 plan (planJarvisRequest) and, only for the one shape J1.2
    // actually executes (code_analysis, read-only, resolved project,
    // available agent), a real run on the exact SAME RunService instance
    // /api/runs uses - so the run is visible through the existing
    // GET /api/runs/:id and /api/history endpoints. Every other shape (an
    // unresolved/ambiguous project, code_implementation, an unavailable
    // agent, an approval-gated prompt) fails closed with a safe error; see
    // orchestrator/jarvis/run-dispatcher.js for why that never silently
    // falls back to a mock run.
    if (request.method === "POST" && pathname === "/api/jarvis/run") {
      if (!isTrustedMutation(request)) return sendJson(response, 403, buildResponse(null, new RouterError("INVALID_REQUEST", "Untrusted local request.")));
      let body;
      try { body = await readJsonBody(request); }
      catch { return sendJson(response, 400, buildResponse(null, new RouterError("INVALID_REQUEST", "Request body must be valid JSON."))); }
      const question = typeof body?.question === "string" ? body.question : "";
      const rawSessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
      const sessionId = rawSessionId && sessionStore.isValidSessionId(rawSessionId) ? rawSessionId : null;
      let plan;
      try {
        plan = planJarvisRequest({
          question,
          sessionId,
          sessionContext: sessionId ? buildSessionContext(sessionStore.getSession(sessionId)) : null
        });
      } catch (error) {
        safeLog("jarvis_run_plan_rejected", { code: error.code || "INTERNAL_ERROR" });
        return sendJson(response, 400, buildResponse(null, error));
      }
      try {
        const dispatch = await dispatchJarvisRun(plan, { runService: service, source: "local" });
        safeLog("jarvis_run_dispatched", { taskClass: plan.taskClass, status: dispatch.status });
        // J1.3 (Phase 6, optional): one bounded session turn recording that a
        // run was started - never the eventual result (not known yet, the
        // run is still async) and never raw agent output. sessionId-gated,
        // same "no session -> no wiring, storage failure never breaks an
        // already-successful response" posture as jarvis-console-proxy.js's
        // own appendTurn call.
        if (sessionId) {
          const projectName = plan.project?.project?.name || plan.project?.project?.id || "dem Projekt";
          try {
            await sessionStore.appendTurn(sessionId, {
              question,
              answer: `Codex-Analyse fuer ${projectName} gestartet (Run ${dispatch.runId}, read-only). Das Ergebnis ist ueber GET /api/jarvis/run/${dispatch.runId} abrufbar, sobald der Lauf abgeschlossen ist.`
            });
          } catch { /* session storage failing must never break an already-dispatched run */ }
        }
        return sendJson(response, 202, { schemaVersion: SCHEMA_VERSION, plan: safeJarvisPlanView(plan), run: dispatch });
      } catch (error) {
        safeLog("jarvis_run_rejected", { taskClass: plan.taskClass, code: error.code || "INTERNAL_ERROR" });
        return sendJson(response, error instanceof RouterError ? 422 : 400, { schemaVersion: SCHEMA_VERSION, plan: safeJarvisPlanView(plan), ...buildResponse(null, error) });
      }
    }

    // J1.3 - Jarvis Result Ingestion. Read-only, no token: same trust level
    // as the other GET /api/jarvis/* routes (e.g. /api/jarvis/today,
    // /api/jarvis/session-status) - it only reads already-authorized local
    // process state, it cannot start or change anything. Reuses the exact
    // same in-memory lookup GET /api/runs/:id already uses (service.get()) -
    // RunService/run-store remain the only source of truth, no second result
    // store. Returns 200 with a null-shaped body for an unknown runId,
    // mirroring GET /api/runs/:id's own not-found convention.
    const jarvisRunResultMatch = pathname.match(/^\/api\/jarvis\/run\/([^/]+)$/);
    if (request.method === "GET" && jarvisRunResultMatch) {
      const result = buildJarvisRunResult(service.get(jarvisRunResultMatch[1]));
      safeLog("jarvis_run_result_checked", { found: String(Boolean(result)) });
      return sendJson(response, 200, { schemaVersion: SCHEMA_VERSION, result });
    }

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

    // R9 - Run-Approval BFF (docs/run-approval-bff-r9.md). Before this,
    // isTrustedMutation() alone protected this route - any local caller
    // without an Origin header could approve or reject any waiting run (see
    // docs/run-approval-trust-boundary-r8.md, section 1). Same auth
    // semantics as R7's /api/actions/:id/approval now applies here: a valid
    // AI_ROUTER_APPROVAL_TOKEN bearer token is required, same error codes,
    // no new token family. The browser page never calls this route
    // directly any more (see decide() in the served HTML) - it goes
    // through the narrow BFF route below, which holds the token
    // server-side and forwards internally.
    const approvalMatch = pathname.match(/^\/api\/runs\/([^/]+)\/approval$/);
    if (request.method === "POST" && approvalMatch) {
      if (!isTrustedMutation(request)) return sendJson(response, 403, buildResponse(null, new RouterError("INVALID_REQUEST", "Untrusted local request.")));
      try {
        authenticateInternalRequest(request.headers.authorization, { expectedToken: process.env.AI_ROUTER_APPROVAL_TOKEN, timingSafeEqualFn });
      } catch (authError) {
        const httpStatus = authError.code === "AUTH_REQUIRED" ? 401 : 403;
        const code = authError.code === "AUTH_REQUIRED" ? "APPROVAL_AUTH_REQUIRED" : "APPROVAL_SOURCE_UNTRUSTED";
        safeLog("run_approval_rejected_auth", { runId: approvalMatch[1], reason: authError.code || "UNKNOWN" });
        return sendJson(response, httpStatus, buildResponse(null, new RouterError(code, "The approval source could not be verified.")));
      }
      safeLog("run_approval_received", { runId: approvalMatch[1], source: "operator-token" });
      return sendJson(response, 200, buildResponse(await service.decideApproval(approvalMatch[1], await readJsonBody(request))));
    }

    // R9 - Run-Approval BFF. The only route the browser page itself is
    // allowed to call. AI_ROUTER_APPROVAL_TOKEN never reaches the client:
    // this handler holds it in process.env and forwards to the exact same
    // decideApproval() the hardened route above uses, entirely in-process -
    // never a second HTTP hop, so there is nothing to intercept between the
    // two. Browser trust here is same-origin (isTrustedMutation, reused
    // from every other browser-facing mutation in this file) PLUS a
    // single-use nonce (approval-nonce-store.js) minted only when this
    // server itself served the page at GET / - a bare curl/script call has
    // neither. The nonce is consumed unconditionally the moment it is
    // checked, valid or not, so one failed attempt always requires a fresh
    // page load; only a *successful* decision hands back a fresh nonce (in
    // `approvalNonce`) so a still-open page can decide a later run too.
    // Client body is read for exactly three fields (decision, decisionNote,
    // nonce) - nothing else is ever interpreted, so this cannot become a
    // generic proxy.
    const approvalUiMatch = pathname.match(/^\/api\/runs\/([^/]+)\/approval\/ui$/);
    if (request.method === "POST" && approvalUiMatch) {
      if (!isTrustedMutation(request)) return sendJson(response, 403, buildResponse(null, new RouterError("INVALID_REQUEST", "Untrusted local request.")));
      const runId = approvalUiMatch[1];
      const body = await readJsonBody(request);
      if (!approvalNonceStore.consume(body?.nonce)) {
        safeLog("run_approval_ui_rejected_nonce", { runId });
        return sendJson(response, 401, buildResponse(null, new RouterError("APPROVAL_NONCE_INVALID", "The approval request could not be verified.")));
      }
      // Fail closed: an unconfigured or too-short token denies every
      // browser decision, never falls back to an unauthenticated forward.
      // Folded into the same APPROVAL_SOURCE_UNTRUSTED code the hardened
      // route above uses for a wrong token - a caller must never learn "no
      // token configured" as information distinct from "untrusted source".
      const approvalToken = process.env.AI_ROUTER_APPROVAL_TOKEN;
      if (typeof approvalToken !== "string" || approvalToken.length < 32) {
        safeLog("run_approval_ui_rejected_auth", { runId, reason: "AUTH_NOT_CONFIGURED" });
        return sendJson(response, 403, buildResponse(null, new RouterError("APPROVAL_SOURCE_UNTRUSTED", "The approval source could not be verified.")));
      }
      safeLog("run_approval_ui_received", { runId, source: "browser-ui" });
      const result = buildResponse(await service.decideApproval(runId, { decision: body?.decision, decisionNote: body?.decisionNote }));
      safeLog("run_approval_ui_forwarded", { runId, decision: typeof body?.decision === "string" ? body.decision : null });
      return sendJson(response, 200, { ...result, approvalNonce: approvalNonceStore.issue() });
    }

    // R5 - Action Resolution + Approval Resume. Human decision endpoint for
    // a request action-service.js left at "approval_required" (see
    // action/action-pending-store.js). Mirrors /api/runs/:id/approval's
    // shape and trust check; approve/reject/resume are collapsed into this
    // one call - see action/action-approval-service.js's own header for why.
    //
    // R7 - Approval Source Hardening + Action Rate Limit
    // (docs/approval-source-hardening-r7.md). isTrustedMutation() alone
    // (same-origin-or-no-origin) let any local caller approve any action -
    // two more gates now sit in front of actionApprovalService.decide(),
    // strictly in this order, and a request that fails either one never
    // reaches decide() (and so never reaches the executor):
    //   1. authenticateInternalRequest() - the caller must present a valid
    //      AI_ROUTER_APPROVAL_TOKEN bearer token. source/actor are fixed,
    //      server-derived constants applied only once this check has
    //      passed - never read from the request body, so a client cannot
    //      spoof either.
    //   2. a rate limiter, keyed by the verified token's identityFingerprint
    //      (never a client-supplied actor), consulted only for decision
    //      "approve" and only when the request is still genuinely
    //      "approval_required" right now - replaying an already-decided id,
    //      retrying an expired id, or an unknown id never consumes budget
    //      and never turns into ACTION_RATE_LIMITED (their existing
    //      404/410/409 responses below are unchanged).
    const actionApprovalMatch = pathname.match(/^\/api\/actions\/([^/]+)\/approval$/);
    if (request.method === "POST" && actionApprovalMatch) {
      if (!isTrustedMutation(request)) return sendJson(response, 403, buildResponse(null, new RouterError("INVALID_REQUEST", "Untrusted local request.")));
      const requestId = decodeURIComponent(actionApprovalMatch[1]);

      let auth;
      try {
        auth = authenticateInternalRequest(request.headers.authorization, {
          expectedToken: process.env.AI_ROUTER_APPROVAL_TOKEN,
          timingSafeEqualFn
        });
      } catch (authError) {
        // AUTH_NOT_CONFIGURED is folded into the same untrusted-source
        // response as AUTH_INVALID on purpose - a caller must never be able
        // to tell "no token configured on the server" apart from "wrong
        // token", which would leak server configuration state.
        const httpStatus = authError.code === "AUTH_REQUIRED" ? 401 : 403;
        const code = authError.code === "AUTH_REQUIRED" ? "APPROVAL_AUTH_REQUIRED" : "APPROVAL_SOURCE_UNTRUSTED";
        safeLog("action_approval_rejected_auth", { requestId, reason: authError.code || "UNKNOWN" });
        return sendJson(response, httpStatus, { schemaVersion: "1.0", error: errorPayload(new RouterError(code, "The approval source could not be verified.")) });
      }

      safeLog("action_approval_received", { requestId, source: "jarvis-ui", actor: "local-user" });

      const body = await readJsonBody(request);
      if (body?.decision === "approve") {
        const pendingBeforeDecision = await actionApprovalService.get(requestId);
        if (pendingBeforeDecision?.status === "approval_required") {
          const rate = actionApprovalRateLimiter().consume(auth.identityFingerprint);
          if (!rate.allowed) {
            response.setHeader("retry-after", String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))));
            safeLog("action_rate_limited", { requestId, retryAfterMs: rate.retryAfterMs });
            return sendJson(response, 429, {
              schemaVersion: "1.0",
              error: errorPayload(new RouterError("ACTION_RATE_LIMITED", "Too many action approvals in a short time.", { retryable: true })),
              retryAfterMs: rate.retryAfterMs
            });
          }
        }
      }

      safeLog("action_approval_accepted", { requestId, decision: typeof body?.decision === "string" ? body.decision : null });

      try {
        const result = await actionApprovalService.decide(requestId, body);
        // action-service.js's own publicView() shape - not run-service.js's
        // buildResponse() projector, which is shaped for adapter runs
        // (routePlan/workflow/provider) and does not apply here.
        return sendJson(response, 200, { schemaVersion: "1.0", ...result });
      } catch (error) {
        if (error?.code === "ACTION_PENDING_NOT_FOUND") return sendJson(response, 404, { schemaVersion: "1.0", error: errorPayload(error) });
        if (error?.code === "ACTION_PENDING_EXPIRED") return sendJson(response, 410, { schemaVersion: "1.0", error: errorPayload(error) });
        if (error?.code === "ACTION_PENDING_ALREADY_DECIDED") return sendJson(response, 409, { schemaVersion: "1.0", error: errorPayload(error) });
        throw error;
      }
    }

    // Read-only lookup of a pending (or already-decided) action request -
    // no execution, no state change.
    const actionPendingMatch = pathname.match(/^\/api\/actions\/([^/]+)$/);
    if (request.method === "GET" && actionPendingMatch) {
      const pending = await actionApprovalService.get(decodeURIComponent(actionPendingMatch[1]));
      if (!pending) return sendJson(response, 404, { schemaVersion: "1.0", error: errorPayload(new RouterError("ACTION_PENDING_NOT_FOUND", "No pending action request with this id.")) });
      return sendJson(response, 200, { schemaVersion: "1.0", pending });
    }

    return sendJson(response, 404, buildResponse(null, new RouterError("INVALID_REQUEST", "Not found.")));
  } catch (error) { return sendJson(response, 400, buildResponse(null, error)); }
  });
  server.requestTimeout = 130_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

// Only attached for the actual `node orchestrator/server.js` process, never
// inside createRouterServer() itself: tests construct their own server
// instances via createRouterServer() and .listen(0, ...) on an ephemeral
// port, and must stay free to attach their own "error" listener (Node
// allows multiple) without this one calling process.exit() underneath them.
// Before this, a busy port 8787 (a second AI-Router instance, or anything
// else already bound there) surfaced as an unhandled "error" event and a
// raw Node stacktrace instead of a clear message - the EADDRINUSE case
// P2-A's Phase 1 analysis flagged.
export function attachServerErrorHandler(server, { port, host, exit = process.exit, logFn = console.error } = {}) {
  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      logFn(`AI Router: port ${port} on ${host} is already in use. Stop the other process (e.g. a previous AI-Router instance) and try again.`);
    } else {
      logFn(`AI Router: server error: ${error?.message || error}`);
    }
    exit(1);
  });
}

// The one canonical way this router process is actually brought up -
// extracted (P2-B) so `npm start` (via the isDirectRun block below) and
// `npm run jarvis:start` (scripts/jarvis-start.js) share the exact same
// bootstrap instead of two near-identical copies. Since F2 (Felix Core
// Foundation v2, 2026-08-18), jarvis-start.js always calls this - it prints
// a readiness report first but no longer gates on it (see the F2 comment at
// the top of scripts/jarvis-start.js for why a process-level start refusal
// was replaced with request-level degradation). Behavior of this function
// itself is unchanged: same port, same host default, same error handler,
// same SIGINT shutdown.
export function startRouterServer({ port = 8787, host = "127.0.0.1" } = {}) {
  const server = createRouterServer();
  attachServerErrorHandler(server, { port, host });
  server.listen(port, host, () => {
    logger.log({ event: "server_started", safeMetadata: { version: ROUTER_VERSION } }).catch(() => {});
    console.log(`AI Router local server: http://${host}:${port}`);
  });
  process.once("SIGINT", () => { logger.log({ event: "server_stopped" }).catch(() => {}); server.close(() => process.exit(0)); });
  return server;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) startRouterServer();
