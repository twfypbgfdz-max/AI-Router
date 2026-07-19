import { RouterError } from "./contracts.js";

export async function readJsonBody(request, maxBytes = 16_384, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
      signal?.removeEventListener("abort", onSignalAbort);
    };
    const fail = (error, drain = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain) request.resume();
      reject(error);
    };
    const onData = (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) fail(new RouterError("PAYLOAD_TOO_LARGE", "Request body is too large."), true);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!body) return resolve({});
      try { return resolve(JSON.parse(body)); }
      catch { return reject(new RouterError("INVALID_REQUEST", "Request body must be valid JSON.")); }
    };
    const onError = () => fail(new RouterError("INVALID_REQUEST", "Request body could not be read."));
    const onAborted = () => fail(new RouterError("INVALID_REQUEST", "Request body was aborted."));
    const onSignalAbort = () => fail(new RouterError("TIMEOUT", "Router request timed out."), true);

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    signal?.addEventListener("abort", onSignalAbort, { once: true });
    if (signal?.aborted) onSignalAbort();
  });
}

export function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

export function sendText(response, statusCode, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, { "content-type": contentType, "cache-control": "no-store" });
  response.end(text);
}
