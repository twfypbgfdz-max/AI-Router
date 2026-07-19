import { handleVercelRouterStatus } from "../../orchestrator/vercel-router-handler.js";

export const config = { maxDuration: 10 };

export default function status(request, response) {
  return handleVercelRouterStatus(request, response);
}
