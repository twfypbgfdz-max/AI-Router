export async function readJsonBody(request, maxBytes = 16_384) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new Error("Request body is too large.");
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new Error("Request body must be valid JSON."); }
}

export function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

export function sendText(response, statusCode, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, { "content-type": contentType, "cache-control": "no-store" });
  response.end(text);
}
