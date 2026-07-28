import crypto from "node:crypto";
import { readJsonBody, sendJson } from "./http-utils.js";
import { handleTextResponseRequest } from "./text-response-handler.js";

// Bridges the browser-facing /router-console UI to the existing
// /api/router/respond pipeline. That pipeline deliberately rejects any
// request carrying a browser Origin header (see text-response-handler.js,
// SECURITY_BLOCKED / browser_origin_blocked) and requires an internal Bearer
// token, so a browser page can never call it directly. This proxy runs
// server-side: it builds a plain internal request object (no Origin header,
// the internal token attached here from the server's own environment) and
// passes it straight into the unmodified handler. No router/core file or
// its response contract is changed.
//
// The handler's own fields are relayed unchanged. A `consoleDiagnostics`
// field is added on top, console-proxy-only, never part of the real
// /api/router/respond envelope. It exists so this proxy can carry the
// diagnostic view without ever touching the upstream contract that the
// Cockpit BFF validates with a strict top-level field allowlist
// (felix-cockpit/ai-router-response-bff.js) - adding a field there would
// reject every real Cockpit response. It is built only from fields the
// handler already returned - nothing new is computed or tracked.
const MAX_CONSOLE_BODY_BYTES = 32_768;

function buildConsoleRequestId() {
  return `console-${crypto.randomUUID()}`;
}

function internalRequestFor(question, token) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: {
      schemaVersion: "1.0",
      requestId: buildConsoleRequestId(),
      source: "internal_test",
      intent: "auto",
      input: { type: "text", content: question }
    }
  };
}

function captureResponse() {
  return {
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    body: "",
    setHeader() {},
    end(chunk = "") {
      this.body = chunk;
      this.writableEnded = true;
    }
  };
}

// Derived only from fields the handler already put in its own payload
// (route.name/taskType, provider.providerId, error.reasonCode). No new
// signal is computed, tracked or inferred - this pipeline has exactly one
// provider selection per request and no retry/fallback path (see
// docs/text-response-pipeline-v1.md), so there is no separate "fallback
// used" fact to expose.
function buildConsoleDiagnostics(payload) {
  if (!payload || typeof payload !== "object") return null;
  const route = payload.route && typeof payload.route === "object" ? payload.route : null;
  const provider = payload.provider && typeof payload.provider === "object" ? payload.provider : null;
  const error = payload.error && typeof payload.error === "object" ? payload.error : null;
  return Object.freeze({
    selectedProviderId: provider ? provider.providerId : null,
    routeName: route ? route.name : null,
    taskType: route ? route.taskType : null,
    validationReasonCode: error ? (error.reasonCode || null) : null
  });
}

export function createRouterConsoleRespondHandler({
  env = process.env,
  textResponseHandler = handleTextResponseRequest
} = {}) {
  return async function handleRouterConsoleRespond(request, response) {
    let question = "";
    try {
      const raw = await readJsonBody(request, MAX_CONSOLE_BODY_BYTES);
      question = typeof raw?.question === "string" ? raw.question : "";
    } catch {
      return sendJson(response, 400, {
        status: "failed",
        error: { code: "INVALID_REQUEST", message: "Request body must be valid JSON." }
      });
    }
    const token = typeof env.AI_ROUTER_INTERNAL_TOKEN === "string" ? env.AI_ROUTER_INTERNAL_TOKEN : "";
    const internalRequest = internalRequestFor(question, token);
    const internalResponse = captureResponse();
    const payload = await textResponseHandler(internalRequest, internalResponse);
    const enrichedPayload = Object.assign({}, payload, { consoleDiagnostics: buildConsoleDiagnostics(payload) });
    return sendJson(response, internalResponse.statusCode, enrichedPayload);
  };
}

export const handleRouterConsoleRespond = createRouterConsoleRespondHandler();
