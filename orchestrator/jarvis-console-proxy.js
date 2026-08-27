import { EventEmitter } from "node:events";
import { sendJson } from "./http-utils.js";
import { createKnowledgeHandler } from "./knowledge-handler.js";
import {
  JARVIS_ASK_MAX_CONCURRENT_REQUESTS,
  JARVIS_ASK_MAX_REQUESTS_PER_WINDOW,
  JARVIS_ASK_RATE_WINDOW_MS,
  KNOWLEDGE_ABSOLUTE_TIMEOUT_MS,
  KNOWLEDGE_SCHEMA_VERSION,
  KNOWLEDGE_TOKEN_ENV_VAR
} from "./knowledge-config.js";
import { fetchCockpitStatus } from "./cockpit-client.js";
import { matchJarvisDailyIntent } from "./jarvis-daily-intent.js";
import { buildJarvisDailyContext } from "./jarvis-daily-context.js";
import { sessionStore as defaultSessionStore } from "./session/session-store.js";
import { buildSessionContext } from "./session/session-context.js";
import { classifyIntent } from "./intent/intent-router.js";
import { actionService as defaultActionService } from "./action/action-service.js";
import { buildActionRequestFromIntent } from "./action/action-intent-bridge.js";
import { actionPendingStore as defaultActionPendingStore } from "./action/action-pending-store.js";
import { logger as defaultLogger } from "./logger.js";

// Bridges the browser-facing /jarvis page to the same knowledge-answering
// engine as POST /api/v1/knowledge, via createKnowledgeHandler
// (knowledge-handler.js) - not that route's own HTTP entry point, and (since
// the 2026-08-27 cooldown fix below) not its exported singleton either.
//
// This proxy runs server-side and builds a plain internal request object
// (no Origin, token attached here from process.env), exactly the pattern
// router-console-proxy.js already uses for /api/router/respond. A page can
// never reach the knowledge engine directly - the token stays in the
// server's environment and never reaches a browser.
//
// It relays the knowledge route's observation envelope byte-for-byte,
// including its state, warnings and HTTP status: a 429 from this proxy's
// own rate limiter therefore reaches the page as a real 429, so the UI can
// say "läuft bereits / Limit erreicht" instead of hanging or showing a raw
// error.
//
// Real-usage finding (2026-08-27): from P6-A until now, this proxy called
// the exact exported singleton (handleKnowledgeRequest) that /api/v1/knowledge
// uses in server.js, so both routes shared one rate/concurrency budget - a
// deliberate choice at the time, to protect the single, concurrency=1
// Ollama instance from being double-booked by two consumers. That also
// meant Jarvis was stuck on /api/v1/knowledge's 60s window, which real
// use of the /jarvis console showed to be needlessly long for a human
// asking follow-up questions. This proxy now builds its own
// createKnowledgeHandler instance (defaultJarvisKnowledgeHandler below)
// with its own budget (JARVIS_ASK_* in knowledge-config.js: still one
// concurrent request, one request per window, but a 5s window instead of
// 60s). /api/v1/knowledge's own singleton in server.js is untouched -
// still KNOWLEDGE_MAX_CONCURRENT_REQUESTS/KNOWLEDGE_MAX_REQUESTS_PER_WINDOW
// and the fixed 60s window - so this route can no longer throttle it, or be
// throttled by it. The two routes can therefore now each have one Ollama
// call in flight at the same time (2 total, not 1) in the rare case both
// are used concurrently; each route's own concurrency=1 budget is otherwise
// unchanged.
//
// operationalContextProviderFn stays this proxy's one addition (P6-A) to
// the shared knowledge engine: a read-only Felix Cockpit call plus a
// deterministic day-intent match on the already-received question - never
// from anything the page can influence beyond asking a day-shaped question
// in the first place. /api/v1/knowledge's own call site never supplies
// this, so cockpit data can only ever reach a prompt through this one route.
const MAX_CONSOLE_BODY_BYTES = 8_192;

// Deterministic first (no network call for the common case of a non-day
// question), then one bounded, read-only Cockpit GET only when the
// question actually needs it. Never throws: a Cockpit outage must degrade
// to "no operational context", never take the knowledge route down with it
// (see the try/catch in knowledge-handler.js around this call).
export async function jarvisOperationalContextProvider(question, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const intent = matchJarvisDailyIntent(question);
  if (!intent) return null;
  const cockpitStatus = await fetchCockpitStatus({ env, fetchImpl });
  return buildJarvisDailyContext({ cockpitStatus, intent });
}

// R1 (Session/Context Manager, Felix Core Foundation v2). Pure RAM lookup,
// never throws by construction (session-store.js's getSession() already
// returns null instead of throwing for a missing/invalid/expired session,
// and buildSessionContext() returns null for a null/empty session) - the
// try/catch in knowledge-handler.js around this provider is defense in
// depth, not something this function relies on.
function jarvisSessionContextProvider(sessionId, { sessionStore }) {
  return buildSessionContext(sessionStore.getSession(sessionId));
}

// The page posts {question}; the knowledge contract wants
// {schemaVersion, question}. Filling schemaVersion here rather than letting
// the page send it keeps the contract version a server-side fact - a stale
// cached page cannot pin an old version, it just gets the current one.
function internalRequestFor(question, token) {
  const request = new EventEmitter();
  request.method = "POST";
  request.headers = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
  request.socket = new EventEmitter();
  const body = JSON.stringify({ schemaVersion: "1.0", question });
  queueMicrotask(() => {
    request.emit("data", body);
    request.emit("end");
  });
  return request;
}

function captureResponse() {
  const headers = new Map();
  return {
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    body: "",
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(chunk = "") {
      this.body = chunk;
      this.writableEnded = true;
    }
  };
}

async function readRawBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
        request.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

// A dedicated createKnowledgeHandler() instance, built once at module init -
// deliberately not server.js's /api/v1/knowledge singleton (see the
// 2026-08-27 finding in the file header above). Its own JARVIS_ASK_* budget
// (knowledge-config.js) is what gives the /jarvis console its own, shorter
// cooldown without touching /api/v1/knowledge's or cc/knowledge's.
// callOptions is a third, per-call-only argument (R1 addition) - it is how
// a single request's sessionContextProviderFn reaches this instance without
// baking a specific session into its construction-time closure.
function defaultJarvisKnowledgeHandler(env, fetchImpl) {
  const handleJarvisKnowledgeRequest = createKnowledgeHandler({
    env,
    maxConcurrentRequests: JARVIS_ASK_MAX_CONCURRENT_REQUESTS,
    maxRequestsPerWindow: JARVIS_ASK_MAX_REQUESTS_PER_WINDOW,
    rateWindowMs: JARVIS_ASK_RATE_WINDOW_MS,
    totalTimeoutMs: KNOWLEDGE_ABSOLUTE_TIMEOUT_MS,
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    operationalContextProviderFn: (question) => jarvisOperationalContextProvider(question, { env, fetchImpl })
  });
  return (request, response, callOptions = {}) => handleJarvisKnowledgeRequest(request, response, callOptions);
}

export function createJarvisConsoleHandler({
  env = process.env,
  // Test-only seam: production never overrides this, it only exists so a
  // test can observe/mock the one outbound network call this proxy can
  // make (the Cockpit GET), without needing to override the whole
  // knowledgeHandler and reimplement its transport logic.
  fetchImpl = globalThis.fetch,
  knowledgeHandler = defaultJarvisKnowledgeHandler(env, fetchImpl),
  // Test-only seam, same reasoning as fetchImpl above: production always
  // uses the one process-wide RAM store (session/session-store.js).
  sessionStore = defaultSessionStore,
  // R4 (Action Foundation). Test-only seam: production always uses the one
  // process-wide service over the default registry (action/action-service.js).
  actionService = defaultActionService,
  // R5 (Action Resolution + Approval Resume). Same test-only-seam reasoning.
  actionPendingStore = defaultActionPendingStore,
  logger = defaultLogger
} = {}) {
  return async function handleJarvisConsoleAsk(request, response) {
    let question = "";
    let sessionId = null;
    try {
      const raw = await readRawBody(request, MAX_CONSOLE_BODY_BYTES);
      const parsed = JSON.parse(raw);
      question = typeof parsed?.question === "string" ? parsed.question : "";
      // Optional (R1): existing clients that never send sessionId keep
      // working exactly as before - sessionId stays null, no session
      // wiring runs at all. An invalid or unknown-shaped value is silently
      // treated as "no session" rather than rejected, matching F4 §8's
      // "a broken session id is never interpreted, only discarded" rule.
      const rawSessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : null;
      sessionId = rawSessionId && sessionStore.isValidSessionId(rawSessionId) ? rawSessionId : null;
    } catch {
      return sendJson(response, 400, {
        schemaVersion: "1.0",
        error: { code: "INVALID_REQUEST", message: "Request body must be valid JSON." }
      });
    }

    // R2 (Intent Consolidation). Classified before any RAG/Cockpit work
    // starts (spec §9) - the session context used here is the same,
    // already-cheap RAM lookup jarvisSessionContextProvider below performs
    // anyway, just read once so the classifier can see it too.
    const sessionContextForIntent = sessionId ? buildSessionContext(sessionStore.getSession(sessionId)) : null;
    const classification = classifyIntent({
      question,
      sessionContext: sessionContextForIntent,
      routeContext: { route: "ask" }
    });

    // Fail-closed by design (R2 spec §11/§21): an action is recognized, never
    // executed inline. No Cockpit call, no RAG search, no knowledge-route
    // budget spent on a question this path can never fulfil by itself.
    //
    // R4 (Action Foundation) changed how the denial is produced: instead of
    // a fixed string, the request goes through the real action pipeline
    // (registry -> policy -> executor boundary -> audit).
    //
    // R5 (Action Resolution) adds one more step ahead of that: the bridge
    // now asks action-resolver.js whether the question deterministically
    // matches exactly one registered action (see
    // action/action-intent-bridge.js). A resolved request can therefore
    // reach approval_required or even completed here - but it never claims
    // a false success: executionAvailable only ever reflects whether an
    // executor actually ran (action-service.js's own `executed` flag), and
    // an approval-gated request is reported as such, never as done.
    if (classification.intent === "action") {
      // The resolver must be anchored to the exact same registry
      // action-service.js is about to resolve against (actionService.registry)
      // - never a module-level default that could silently drift from
      // whichever actionService instance was injected (production vs. a
      // test's fixture registry).
      const built = buildActionRequestFromIntent(classification, { question, registry: actionService.registry });
      let actionRequest = null;
      try {
        actionRequest = await actionService.submit(built);
      } catch {
        // A malformed envelope is a bug in the bridge, not something a
        // question can cause; degrade to the plain denial rather than
        // turning a recognized action into a 500.
      }

      // R5: audit the resolution outcome itself (never the question text),
      // separately from action-service.js's own lifecycle audit trail.
      const resolutionKind = built?.resolution?.resolution ?? "invalid";
      if (resolutionKind === "resolved" || resolutionKind === "ambiguous" || resolutionKind === "unresolved") {
        try {
          await logger.log({
            level: "info",
            event: `action_resolution_${resolutionKind}`,
            requestId: actionRequest?.requestId ?? null,
            safeMetadata: resolutionKind === "resolved" ? { actionId: built.resolution.actionId } : {}
          });
        } catch { /* audit never changes the outcome */ }
      }

      // R5: a request that stopped at approval_required is persisted so a
      // later, separate HTTP call can resume it (see
      // action/action-pending-store.js and action/action-approval-service.js).
      // Never persisted for an already-terminal outcome (rejected/completed/
      // failed) - there is nothing left to resume.
      if (actionRequest?.status === "approval_required") {
        try {
          await actionPendingStore.create({
            requestId: actionRequest.requestId,
            actionId: actionRequest.actionId,
            parameters: actionRequest.parameters,
            origin: actionRequest.origin,
            risk: actionRequest.risk
          });
          await logger.log({ level: "info", event: "action_pending_stored", requestId: actionRequest.requestId, safeMetadata: { actionId: actionRequest.actionId } });
        } catch {
          // Persistence failing must not turn an already-produced, correctly
          // audited approval_required response into a 500 - the caller can
          // still see approvalRequired: true, it just cannot be resumed
          // later if the write genuinely failed.
        }
      }

      // R5: the answer text must never claim a success that did not happen,
      // and must never claim "not executed" for a request that genuinely
      // was (see R5 spec §13 - "keine falsche Erfolgsmeldung" cuts both
      // ways). Three honest shapes, chosen by action-service.js's own
      // status/executed fields - never guessed here.
      const answer = actionRequest?.executed === true
        ? "Die erkannte Aktion wurde ausgeführt."
        : actionRequest?.status === "approval_required"
          ? "Ich habe eine Handlungsanfrage erkannt. Diese Aktion erfordert eine Freigabe, bevor sie ausgeführt werden kann; die Anfrage wurde gespeichert und wartet auf Freigabe."
          : "Ich habe eine Handlungsanfrage erkannt (z. B. senden, löschen, öffnen, erstellen, ausführen, verschieben, ändern). Die Ausführung von Aktionen ist noch nicht Teil dieses Pfads - diese Anfrage wurde erkannt, aber nicht ausgeführt.";

      const payload = {
        schemaVersion: "1.0",
        state: "unavailable",
        warnings: [],
        sources: [],
        answer,
        intent: classification.intent,
        executionAvailable: actionRequest?.executed === true,
        // Audit handle for this request. Null only if the pipeline itself
        // could not be entered at all.
        actionRequestId: actionRequest?.requestId ?? null,
        actionStatus: actionRequest?.status ?? null,
        actionErrorCode: actionRequest?.error?.code ?? null,
        approvalRequired: actionRequest?.approval?.required === true
      };
      return sendJson(response, 200, payload);
    }

    // The token is read per request rather than captured at module load so
    // that a token set after the process started is still picked up, and so
    // a missing one surfaces as the knowledge route's own
    // AUTH_NOT_CONFIGURED rather than a silent empty header.
    const internalRequest = internalRequestFor(question, env[KNOWLEDGE_TOKEN_ENV_VAR]);
    const internalResponse = captureResponse();
    // sessionId never reaches internalRequestFor above: the /api/v1/knowledge
    // contract this internal request carries is unchanged by R1 (see
    // internalRequestFor's own comment) - session context is threaded in
    // only through this third, Jarvis-only argument.
    const callOptions = sessionId
      ? { sessionContextProviderFn: () => jarvisSessionContextProvider(sessionId, { sessionStore }) }
      : {};
    await knowledgeHandler(internalRequest, internalResponse, callOptions);

    let payload;
    try {
      payload = JSON.parse(internalResponse.body);
    } catch {
      return sendJson(response, 500, {
        schemaVersion: "1.0",
        error: { code: "INTERNAL_ERROR", message: "The knowledge request could not be completed." }
      });
    }

    // Only a genuinely answered request becomes a stored turn (R1 §10): a
    // transport failure (payload.error) or an "unavailable" knowledge state
    // never carries a non-empty payload.answer, so both are excluded by
    // this one check without needing to inspect payload.state separately.
    // Storage failure must never turn an already-successful answer into a
    // failed response - hence the catch below, not a return.
    if (sessionId && typeof payload.answer === "string" && payload.answer.length > 0) {
      try {
        await sessionStore.appendTurn(sessionId, { question, answer: payload.answer });
      } catch {
        // Never break an already-successful answer over session storage.
      }
    }

    // R2 spec §12 evaluated adding classification.intent as a response
    // field here and deliberately did not: this proxy's own existing
    // contract is "relays the observation payload unchanged" (see
    // "relays the observation payload unchanged" in jarvis-console.test.js)
    // - that invariant is worth more than one metadata field, so intent
    // stays internal to this handler (used above only to decide the action
    // short-circuit) rather than being spliced into the relayed payload.

    return sendJson(response, internalResponse.statusCode, payload);
  };
}

export const handleJarvisConsoleAsk = createJarvisConsoleHandler();
