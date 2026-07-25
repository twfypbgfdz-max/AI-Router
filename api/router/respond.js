import { handleTextResponseRequest } from "../../orchestrator/text-response-handler.js";

export const config = { maxDuration: 25 };

export default function respond(request, response) {
  return handleTextResponseRequest(request, response);
}
