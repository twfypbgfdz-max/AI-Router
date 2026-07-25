import crypto from "node:crypto";
import { TextResponseError } from "./text-response-error.js";

function digest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function bearerToken(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] || null;
}

export function authenticateInternalRequest(
  authorizationHeader,
  {
    expectedToken = process.env.AI_ROUTER_INTERNAL_TOKEN,
    timingSafeEqualFn = crypto.timingSafeEqual
  } = {}
) {
  if (typeof expectedToken !== "string" || expectedToken.length < 32) {
    throw new TextResponseError("AUTH_NOT_CONFIGURED", "Internal authentication is unavailable.");
  }
  const token = bearerToken(authorizationHeader);
  if (!token) {
    throw new TextResponseError("AUTH_REQUIRED", "Internal authentication is required.");
  }
  const actualDigest = digest(token);
  const expectedDigest = digest(expectedToken);
  if (!timingSafeEqualFn(actualDigest, expectedDigest)) {
    throw new TextResponseError("AUTH_INVALID", "Internal authentication failed.");
  }
  return Object.freeze({
    identityFingerprint: expectedDigest.toString("hex").slice(0, 24)
  });
}

export const internalAuthInternals = Object.freeze({ bearerToken });
