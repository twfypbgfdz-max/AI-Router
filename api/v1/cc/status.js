import { handleCcStatusRequest } from "../../../orchestrator/cc-status-handler.js";

export const config = { maxDuration: 10 };

export default function status(request, response) {
  return handleCcStatusRequest(request, response);
}
