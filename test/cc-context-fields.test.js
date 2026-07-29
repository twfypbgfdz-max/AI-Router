import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCcContext } from "../orchestrator/cc-context-fields.js";

class TestFieldError extends Error {
  constructor(code, field, reason) {
    super(`${code}:${field}:${reason}`);
    this.code = code;
    this.field = field;
    this.reason = reason;
  }
}

function errorsFor(collector) {
  return {
    fail(field, reason) {
      throw new TestFieldError("VALIDATION_FAILED", field, reason);
    },
    failSecurity(field, reason) {
      throw new TestFieldError("SECURITY_BLOCKED", field, reason);
    }
  };
}

test("normalizeCcContext works with an injected, independent error class", () => {
  const context = normalizeCcContext({ projectId: "p1", projectName: "Project One" }, errorsFor());
  assert.equal(context.projectId, "p1");
  assert.equal(context.projectName, "Project One");
});

test("normalizeCcContext still rejects unknown fields via the injected errors", () => {
  assert.throws(
    () => normalizeCcContext({ projectId: "p1", projectName: "P", extra: "nope" }, errorsFor()),
    (error) => error instanceof TestFieldError && error.code === "VALIDATION_FAILED" && error.reason === "unknown_field"
  );
});

test("normalizeCcContext still routes secret-like content through failSecurity, not fail", () => {
  assert.throws(
    () => normalizeCcContext({ projectId: "p1", projectName: "ok", cloudSummary: "token: sk-proj-abcdefghijklmnopqrstuvwx" }, errorsFor()),
    (error) => error instanceof TestFieldError && error.code === "SECURITY_BLOCKED"
  );
});

test("normalizeCcContext still rejects a path-like string", () => {
  assert.throws(
    () => normalizeCcContext({ projectId: "p1", projectName: "C:\\Users\\felil\\secret.txt" }, errorsFor()),
    (error) => error.reason === "path_like"
  );
});
