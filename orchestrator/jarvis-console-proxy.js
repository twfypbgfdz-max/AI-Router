import { EventEmitter } from "node:events";
import { sendJson } from "./http-utils.js";
import { handleKnowledgeRequest } from "./knowledge-handler.js";
import { KNOWLEDGE_TOKEN_ENV_VAR } from "./knowledge-config.js";

// Bridges the browser-facing /jarvis page to POST /api/v1/knowledge.
//
// That route deliberately rejects any request carrying a browser Origin
// header and requires a bearer token, so a page can never call it directly -
// which is the point: the token stays in the server's environment and never
// reaches a browser. This proxy runs server-side, builds a plain internal
// request object (no Origin, token attached here from process.env) and
// passes it into the unmodified handler. Exactly the pattern
// router-console-proxy.js already uses for /api/router/respond.
//
// It adds nothing to the payload and interprets nothing: the knowledge
// route's observation envelope is relayed byte-for-byte, including its
// state, warnings and HTTP status. The 429 from the route's rate limiter
// therefore reaches the page as a real 429, so the UI can say "läuft
// bereits / Limit erreicht" instead of hanging or showing a raw error.
const MAX_CONSOLE_BODY_BYTES = 8_192;

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

export function createJarvisConsoleHandler({
  env = process.env,
  knowledgeHandler = handleKnowledgeRequest
} = {}) {
  return async function handleJarvisConsoleAsk(request, response) {
    let question = "";
    try {
      const raw = await readRawBody(request, MAX_CONSOLE_BODY_BYTES);
      const parsed = JSON.parse(raw);
      question = typeof parsed?.question === "string" ? parsed.question : "";
    } catch {
      return sendJson(response, 400, {
        schemaVersion: "1.0",
        error: { code: "INVALID_REQUEST", message: "Request body must be valid JSON." }
      });
    }

    // The token is read per request rather than captured at module load so
    // that a token set after the process started is still picked up, and so
    // a missing one surfaces as the knowledge route's own
    // AUTH_NOT_CONFIGURED rather than a silent empty header.
    const internalRequest = internalRequestFor(question, env[KNOWLEDGE_TOKEN_ENV_VAR]);
    const internalResponse = captureResponse();
    await knowledgeHandler(internalRequest, internalResponse);

    let payload;
    try {
      payload = JSON.parse(internalResponse.body);
    } catch {
      return sendJson(response, 500, {
        schemaVersion: "1.0",
        error: { code: "INTERNAL_ERROR", message: "The knowledge request could not be completed." }
      });
    }
    return sendJson(response, internalResponse.statusCode, payload);
  };
}

export const handleJarvisConsoleAsk = createJarvisConsoleHandler();
