import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { REPOSITORY_ROOT } from "./config.js";
import { RunService } from "./run-service.js";
import { loadLatestRun } from "./run-store.js";
import { loadCockpitStatus } from "./cockpit-status.js";
import { readJsonBody, sendJson, sendText } from "./http-utils.js";

const service = new RunService();
const uiFile = path.join(REPOSITORY_ROOT, "01_APP", "tests", "ai-router-v0_6-test.html");
function isTrustedMutation(request) {
  const origin = request.headers.origin;
  const contentType = request.headers["content-type"] || "";
  return (!origin || origin === "http://127.0.0.1:8787") && contentType.toLowerCase().startsWith("application/json");
}
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") return sendText(response, 200, await fs.readFile(uiFile, "utf8"), "text/html; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/api/health") return sendJson(response, 200, { ok: true });
    if (request.method === "POST" && url.pathname === "/api/runs") {
      if (!isTrustedMutation(request)) return sendJson(response, 403, { error: "Untrusted local request." });
      return sendJson(response, 202, await service.create(await readJsonBody(request)));
    }
    if (request.method === "GET" && url.pathname === "/api/runs/latest") return sendJson(response, 200, await loadLatestRun());
    if (request.method === "GET" && url.pathname === "/api/cockpit-status") return sendJson(response, 200, await loadCockpitStatus());
    const match = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (request.method === "GET" && match) return sendJson(response, 200, service.get(match[1]) || { error: "Run not found." });
    const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      if (!isTrustedMutation(request)) return sendJson(response, 403, { error: "Untrusted local request." });
      const run = await service.cancel(cancelMatch[1]); return run ? sendJson(response, 200, run) : sendJson(response, 409, { error: "Run cannot be cancelled." });
    }
    return sendJson(response, 404, { error: "Not found." });
  } catch (error) { return sendJson(response, 400, { error: error.message }); }
});
server.listen(8787, "127.0.0.1", () => console.log("AI Router local server: http://127.0.0.1:8787"));
