import { normalizeClassificationText } from "./task-classifier.js";
import { TextResponseError } from "./text-response-error.js";

const SECRET_PATTERNS = Object.freeze([
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_ -]?key|token|secret|password|passwort|credential)\s*[:=]\s*["']?[^\s"',;]{8,}/i
]);

const EXECUTION_PATTERNS = Object.freeze([
  /\b(?:run|execute|start|fuhre|starte)\b.{0,48}\b(?:shell|powershell|terminal|cmd|command|befehl)\b/,
  /\b(?:shell|powershell|terminal|cmd)\b.{0,48}\b(?:run|execute|start|fuhre|starte)\b/,
  /^(?:please\s+|bitte\s+)?(?:send|sende|verschicke)\b.{0,48}\b(?:e-?mail|mail|message|nachricht)\b/,
  /^(?:please\s+|bitte\s+)?(?:create|write|edit|modify|delete|remove|erstell|schreib|ander|losch|entfern)\w*\b.{0,48}\b(?:file|folder|datei|ordner|repository|repo)\b/,
  /^(?:please\s+|bitte\s+)?(?:git\s+)?(?:commit|push|merge|rebase|reset|deploy)\w*\b/,
  /\b(?:can|could|would|kannst|konntest|wurdest)\s+(?:you|du)?\s*(?:please\s+|bitte\s+)?(?:commit|push|merge|rebase|reset|deploy|send|sende|losch|delete|run|execute)\w*\b/,
  /\b(?:change|edit|delete|ander|losch)\w*\b.{0,40}\b(?:calendar|kalender)\b/
]);

function containsSecretLikeContent(value) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(String(value || "")));
}

function isExecutionRequest(value) {
  const normalized = normalizeClassificationText(value);
  return EXECUTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function assertProviderEgressAllowed(request, { executionRequestText = request.input.content } = {}) {
  if (request.context?.containsPrivateData === true) {
    throw new TextResponseError("SECURITY_BLOCKED", "Context is not allowed to leave the router.", {
      safeDetails: { reason: "private_context" }
    });
  }
  if (request.context?.privacyLevel === "local-only") {
    throw new TextResponseError("SECURITY_BLOCKED", "Context is restricted to local processing.", {
      safeDetails: { reason: "local_only_context" }
    });
  }
  if (request.context && request.context.privacyLevel !== "external-provider-allowed") {
    throw new TextResponseError("SECURITY_BLOCKED", "Context privacy classification is not eligible for provider egress.", {
      safeDetails: { reason: "privacy_classification_invalid" }
    });
  }
  if (containsSecretLikeContent(request.input.content) || containsSecretLikeContent(request.context?.content)) {
    throw new TextResponseError("SECURITY_BLOCKED", "Secret-like content cannot be sent to the provider.", {
      safeDetails: { reason: "secret_like_content" }
    });
  }
  if (isExecutionRequest(executionRequestText)) {
    throw new TextResponseError("SECURITY_BLOCKED", "Execution requests are not supported by this endpoint.", {
      safeDetails: { reason: "execution_request_blocked" }
    });
  }
}

export const providerEgressPolicyInternals = Object.freeze({
  containsSecretLikeContent,
  isExecutionRequest
});
