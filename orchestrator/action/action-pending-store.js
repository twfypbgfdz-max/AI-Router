// R5 - Action Resolution + Approval Resume. Persists an action request that
// stopped at "approval_required" so it can be resumed by a later, separate
// HTTP call - the gap R4 explicitly left open (see docs/action-foundation-r4.md
// "Offen für R5").
//
// File-based, atomic-write persistence, deliberately copying run-store.js's
// existing pattern (temp file + rename under DATA_DIR) rather than adding a
// new storage dependency - this is "eine lokale, kleine persistente
// Struktur", not a database. What is stored is the minimum the R5 spec asks
// for: no user question, no secrets, just the already registry-validated
// request shape plus lifecycle bookkeeping.
//
// Concurrency: this process is single-node, exactly like session-store.js
// (RAM-only) and run-service.js's in-memory approval consumption - so the
// "exactly once" guarantee for a decision is provided by an in-memory,
// per-requestId promise chain (identical technique to session-store.js's
// writeLocks), while the record itself is written to disk so it survives a
// process restart in between. A record's status only ever moves forward:
// approval_required -> approved -> {completed|failed}, or
// approval_required -> {rejected|expired} - never back. That one-way move
// is what makes replay (resubmitting an already-decided/expired request)
// impossible.
import fs from "node:fs/promises";
import path from "node:path";
import { ACTION_PENDING_DIR, ACTION_PENDING_TTL_MS } from "../config.js";

const PENDING_STATUSES = Object.freeze(["approval_required", "approved", "rejected", "expired", "completed", "failed"]);
const RESUME_TERMINAL_STATUSES = new Set(["completed", "failed"]);
const REQUEST_ID_PATTERN = /^act_[0-9]+_[0-9a-f]{8}$/;
const MAX_ACTOR_LENGTH = 64;

function isValidRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

function recordFile(dir, requestId) {
  return path.join(dir, `${requestId}.json`);
}

async function readRecord(dir, requestId) {
  try {
    const raw = await fs.readFile(recordFile(dir, requestId), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !PENDING_STATUSES.includes(parsed.status)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// A record is treated as expired the moment "now" passes expiresAt, but it
// is only ever flipped to the terminal "expired" status lazily, on the next
// read/decision attempt that observes it - no background timer, same "lazy
// cleanup only" posture session-store.js already documents for its own TTL.
function isPastTtl(record, now) {
  return record.status === "approval_required" && Date.parse(record.expiresAt) <= now;
}

export function createActionPendingStore({ dir = ACTION_PENDING_DIR, ttlMs = ACTION_PENDING_TTL_MS, now = () => Date.now() } = {}) {
  const writeLocks = new Map();

  // Serializes every write for one requestId behind the previous one,
  // regardless of whether it resolved or rejected - a failed attempt must
  // never wedge every later attempt for the same id behind it.
  function runLocked(requestId, fn) {
    const previous = writeLocks.get(requestId) || Promise.resolve();
    const run = previous.then(fn, fn);
    writeLocks.set(requestId, run.then(() => {}, () => {}));
    return run;
  }

  return Object.freeze({
    // Called once, right after action-service.js's submit() returns a
    // request with status "approval_required". Only the fields the R5 spec
    // names as necessary are kept - already registry-validated enum
    // parameter values, no free text, no user question.
    async create({ requestId, actionId, parameters, origin, risk }) {
      if (!isValidRequestId(requestId)) throw new Error("A pending action record requires a valid requestId.");
      const t = now();
      const record = {
        requestId,
        actionId,
        parameters: parameters && typeof parameters === "object" ? { ...parameters } : {},
        origin,
        risk: risk || null,
        status: "approval_required",
        createdAt: new Date(t).toISOString(),
        expiresAt: new Date(t + ttlMs).toISOString(),
        decidedBy: null,
        decidedAt: null
      };
      await atomicWrite(recordFile(dir, requestId), record);
      return record;
    },

    // Read-only lookup. Applies the lazy TTL check so a caller never sees a
    // stale "approval_required" that is actually past its expiry - but a
    // plain read never itself claims/consumes the record (see
    // claimForDecision below for that).
    async get(requestId) {
      if (!isValidRequestId(requestId)) return null;
      const record = await readRecord(dir, requestId);
      if (!record) return null;
      if (isPastTtl(record, now())) {
        record.status = "expired";
        try { await atomicWrite(recordFile(dir, requestId), record); } catch { /* best effort */ }
      }
      return record;
    },

    // The one write path that may move a record out of "approval_required".
    // Serialized per requestId so two near-simultaneous decisions for the
    // same request can never both win (mirrors run-service.js's own
    // "simultaneous approve and reject consume exactly one decision").
    // decision is "approve" | "reject"; on "approve" the record moves to
    // the intermediate "approved" state (still not replayable - see
    // finalizeResume below for the terminal move); on "reject" it moves
    // straight to the terminal "rejected" state.
    //
    // Throws with a stable message on every disallowed case: unknown id
    // (ACTION_PENDING_NOT_FOUND), past TTL (ACTION_PENDING_EXPIRED), or
    // already decided (ACTION_PENDING_ALREADY_DECIDED) - the caller (the
    // approval service) turns that into a safe error code, never into a
    // silent no-op or a second execution.
    async claimForDecision(requestId, { decision, decidedBy, note = "" } = {}) {
      if (decision !== "approve" && decision !== "reject") throw new Error("claimForDecision: decision must be \"approve\" or \"reject\".");
      const actor = typeof decidedBy === "string" ? decidedBy.replace(/[^\w.@-]/g, "").slice(0, MAX_ACTOR_LENGTH) : "";
      if (!actor) throw new Error("ACTION_REQUEST_INVALID");
      return runLocked(requestId, async () => {
        const record = await readRecord(dir, requestId);
        if (!record) throw new Error("ACTION_PENDING_NOT_FOUND");
        if (isPastTtl(record, now())) {
          record.status = "expired";
          await atomicWrite(recordFile(dir, requestId), record);
          throw new Error("ACTION_PENDING_EXPIRED");
        }
        // Already flipped to "expired" by an earlier get()/claim attempt -
        // report the precise reason every time, not the generic
        // "already decided" a caller would otherwise see on a retry.
        if (record.status === "expired") throw new Error("ACTION_PENDING_EXPIRED");
        if (record.status !== "approval_required") throw new Error("ACTION_PENDING_ALREADY_DECIDED");
        record.status = decision === "approve" ? "approved" : "rejected";
        record.decidedBy = actor;
        record.decidedAt = new Date(now()).toISOString();
        record.note = typeof note === "string" ? note.replace(/\s+/g, " ").trim().slice(0, 200) : "";
        await atomicWrite(recordFile(dir, requestId), record);
        return record;
      });
    },

    // Called after action-service.js's submit() has actually run the
    // resumed, approved request to a terminal outcome - records
    // "completed"/"failed" so the record can never be resumed again. Never
    // throws: a failure to persist the terminal outcome must not turn an
    // otherwise-correct execution into an error response, same posture as
    // action-audit.js's own "audit failure never changes the decision".
    async finalizeResume(requestId, status) {
      if (!RESUME_TERMINAL_STATUSES.has(status)) return false;
      return runLocked(requestId, async () => {
        try {
          const record = await readRecord(dir, requestId);
          if (!record || record.status !== "approved") return false;
          record.status = status;
          await atomicWrite(recordFile(dir, requestId), record);
          return true;
        } catch {
          return false;
        }
      });
    }
  });
}

export const actionPendingStore = createActionPendingStore();
