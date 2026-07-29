import { handleCcKnowledgeRequest } from "../../../orchestrator/cc-knowledge-handler.js";

export const config = { maxDuration: 30 };

export default function knowledge(request, response) {
  return handleCcKnowledgeRequest(request, response);
}
