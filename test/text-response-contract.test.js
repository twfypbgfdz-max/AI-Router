import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizeTextResponseRequest } from "../orchestrator/text-response-contract.js";
import { createTextResponseService } from "../orchestrator/text-response-service.js";
import {
  externalContext,
  successfulAdapter,
  textProviderEnv,
  validTextResponseRequest
} from "./text-response-helpers.js";

const now = () => new Date("2026-07-25T14:00:00.000Z");

test("valid general and explicit-context requests normalize without client provider controls", () => {
  const general = normalizeTextResponseRequest(validTextResponseRequest(), { now });
  assert.equal(general.context, null);
  assert.equal(general.input.type, "text");

  const withContext = normalizeTextResponseRequest(validTextResponseRequest({
    source: "cockpit",
    context: externalContext()
  }), { now });
  assert.equal(withContext.context.privacyLevel, "external-provider-allowed");
  assert.equal(withContext.context.containsPrivateData, false);
  assert.equal(withContext.context.capturedAt, "2026-07-25T12:00:00.000Z");
});

test("unknown fields, missing fields, invalid sources, client providers and client models are rejected", () => {
  const cases = [
    validTextResponseRequest({ extra: true }),
    { schemaVersion: "1.0" },
    validTextResponseRequest({ source: "api" }),
    validTextResponseRequest({ provider: "openai" }),
    validTextResponseRequest({ model: "client-model" }),
    validTextResponseRequest({ input: { type: "text", content: "Question", url: "https://client.invalid" } }),
    validTextResponseRequest({ input: { type: "image", content: "Question" } })
  ];
  for (const input of cases) {
    assert.throws(() => normalizeTextResponseRequest(input, { now }), { code: "VALIDATION_FAILED" });
  }
});

test("question, context and combined character boundaries are enforced", () => {
  assert.throws(() => normalizeTextResponseRequest(validTextResponseRequest({
    input: { type: "text", content: "x".repeat(8_001) }
  }), { now }), { code: "INPUT_TOO_LARGE" });
  assert.throws(() => normalizeTextResponseRequest(validTextResponseRequest({
    context: externalContext({ content: "x".repeat(4_001) })
  }), { now }), { code: "INPUT_TOO_LARGE" });

  const boundary = normalizeTextResponseRequest(validTextResponseRequest({
    input: { type: "text", content: "q".repeat(8_000) },
    context: externalContext({ content: "c".repeat(4_000) })
  }), { now });
  assert.equal(boundary.input.content.length + boundary.context.content.length, 12_000);
});

test("privacy classification is mandatory and unknown classifications fail closed", () => {
  const missingContainsPrivate = externalContext();
  delete missingContainsPrivate.containsPrivateData;
  const missingLevel = externalContext();
  delete missingLevel.privacyLevel;
  for (const context of [
    missingContainsPrivate,
    missingLevel,
    externalContext({ privacyLevel: "standard" })
  ]) {
    assert.throws(
      () => normalizeTextResponseRequest(validTextResponseRequest({ context }), { now }),
      { code: "SECURITY_BLOCKED" }
    );
  }
});

test("conservative token estimation blocks oversized multibyte input before adapter creation", async () => {
  const { adapter, calls } = successfulAdapter();
  const service = createTextResponseService({
    env: textProviderEnv(),
    adapterFactory: () => adapter,
    now
  });
  await assert.rejects(
    service.respond(validTextResponseRequest({
      input: { type: "text", content: "🙂".repeat(3_000) }
    }), { signal: new AbortController().signal }),
    { code: "TOKEN_LIMIT_EXCEEDED" }
  );
  assert.equal(calls.length, 0);
});

test("request and response schemas are strict JSON Schema documents", () => {
  for (const file of ["schemas/text-response-request-v1.json", "schemas/text-response-response-v1.json"]) {
    const schema = JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.additionalProperties, false);
  }
});
