import crypto from "node:crypto";
import { ACTION_PENDING_TTL_MS } from "./config.js";

// R9 - Run-Approval BFF. Browser trust boundary for POST
// /api/runs/:id/approval/ui (see docs/run-approval-bff-r9.md). isTrustedMutation()
// alone (same-origin-or-no-origin) is not sufficient for this route - any
// local process without an Origin header would otherwise pass. This nonce is
// the thing a plain curl/script call cannot have: it only exists once a
// browser has actually loaded the page this server itself served at GET /,
// where it is embedded directly into the HTML (never a cookie, never
// LocalStorage/SessionStorage - those are set by page script, this is set by
// the server before the page's own script ever runs).
//
// Deliberately NOT a replacement for AI_ROUTER_APPROVAL_TOKEN: a leaked nonce
// authorizes nothing beyond one decision on this one BFF route, for a few
// minutes, once. The real token never leaves this process (see server.js's
// assertApprovalTokenConfigured()).
const NONCE_TTL_MS = ACTION_PENDING_TTL_MS; // 15 minutes - same "short local-operator gate" convention as R5's action-pending TTL.

export function createApprovalNonceStore({ now = () => Date.now(), ttlMs = NONCE_TTL_MS } = {}) {
  const nonces = new Map(); // nonce -> expiresAt

  function pruneExpired(t) {
    for (const [nonce, expiresAt] of nonces) {
      if (expiresAt <= t) nonces.delete(nonce);
    }
  }

  return Object.freeze({
    issue(t = now()) {
      pruneExpired(t);
      const nonce = crypto.randomBytes(32).toString("hex");
      nonces.set(nonce, t + ttlMs);
      return nonce;
    },
    // Single-use by construction: a nonce is deleted the moment it is
    // checked, whether it turns out valid or not - there is no "peek" path,
    // so the same nonce value can never be validated a second time (no
    // replay), and a nonce that arrives after its TTL is treated exactly
    // like one that was never issued.
    consume(nonce, t = now()) {
      pruneExpired(t);
      if (typeof nonce !== "string" || !nonces.has(nonce)) return false;
      const expiresAt = nonces.get(nonce);
      nonces.delete(nonce);
      return expiresAt > t;
    }
  });
}

// One process-wide singleton, same convention as sessionStore in
// session/session-store.js. Tests build their own instance via
// createApprovalNonceStore() for isolation and a controllable `now`.
export const approvalNonceStore = createApprovalNonceStore();
