import { handleVercelRouterRoute } from "../../orchestrator/vercel-router-handler.js";

export const config = { maxDuration: 10 };

export default function route(request, response) {
  return handleVercelRouterRoute(request, response);
}
