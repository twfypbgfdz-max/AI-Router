import test from "node:test";
import assert from "node:assert/strict";
import { createJsonlParser, reduceEventMetadata } from "../orchestrator/jsonl.js";

test("JSONL parser accepts complete JSON lines", () => { const parser = createJsonlParser(); parser.write('{"type":"item","text":"ok"}\n'); const result = parser.finish(); assert.equal(result.events[0].type, "item"); assert.deepEqual(result.issues, []); });
test("JSONL parser records incomplete lines", () => { const parser = createJsonlParser(); parser.write('{"type":"item"'); assert.ok(parser.finish().issues.includes("incomplete_jsonl")); });
test("JSONL parser bounds oversized lines", () => { const parser = createJsonlParser({ maxLineLength: 8 }); parser.write("123456789"); assert.ok(parser.finish().issues.includes("jsonl_line_too_large")); });
test("event metadata drops raw sensitive fields and masks secrets", () => {
  const reduced = reduceEventMetadata({ type: "tool.completed", message: "token=abc123456", tool_input: { path: "secret.txt" }, output: "file contents", nested: { unknown: true }, usage: { input_tokens: 4, private_detail: "no" } }, "now");
  assert.deepEqual(reduced, { timestamp: "now", type: "tool.completed", messageSummary: "token=[REDACTED]", usage: { input_tokens: 4 } });
  assert.equal(JSON.stringify(reduced).includes("file contents"), false);
  assert.equal(JSON.stringify(reduced).includes("secret.txt"), false);
});
test("unknown event types remain tolerant and flat", () => { const reduced = reduceEventMetadata({ payload: { secret: "value" } }, "now"); assert.deepEqual(reduced, { timestamp: "now", type: "unknown" }); });
