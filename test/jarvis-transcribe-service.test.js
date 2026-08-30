import test from "node:test";
import assert from "node:assert/strict";
import { createJarvisTranscribeService, transcribeInternals } from "../orchestrator/jarvis-transcribe-service.js";
import { WHISPER_SERVER_URL_ENV_VAR, JARVIS_TRANSCRIBE_MAX_TEXT_CHARS } from "../orchestrator/jarvis-transcribe-config.js";

const CONFIGURED_ENV = { [WHISPER_SERVER_URL_ENV_VAR]: "http://127.0.0.1:8399" };

function fakeFetch({ ok = true, status = 200, json = { text: "Hallo Welt" }, throwError = null } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (throwError) throw throwError;
    return {
      ok,
      status,
      json: async () => {
        if (json instanceof Error) throw json;
        return json;
      }
    };
  };
  return { impl, calls };
}

test("throws WHISPER_NOT_CONFIGURED when no server URL is set", async () => {
  const service = createJarvisTranscribeService({ env: {}, fetchImpl: fakeFetch().impl });
  await assert.rejects(
    () => service.transcribe({ audio: Buffer.from([1, 2, 3]), contentType: "audio/wav" }),
    (error) => error.code === "WHISPER_NOT_CONFIGURED"
  );
});

test("treats a blank server URL the same as unset", async () => {
  const service = createJarvisTranscribeService({ env: { [WHISPER_SERVER_URL_ENV_VAR]: "   " }, fetchImpl: fakeFetch().impl });
  await assert.rejects(
    () => service.transcribe({ audio: Buffer.from([1]), contentType: "audio/wav" }),
    (error) => error.code === "WHISPER_NOT_CONFIGURED"
  );
});

test("posts to <base>/inference with the German language, fixed vocabulary prompt and zero temperature", async () => {
  const { impl, calls } = fakeFetch({ json: { text: "Wo liegt Felix Core?" } });
  const service = createJarvisTranscribeService({ env: CONFIGURED_ENV, fetchImpl: impl });
  const result = await service.transcribe({ audio: Buffer.from([9, 9]), contentType: "audio/wav" });

  assert.equal(result.text, "Wo liegt Felix Core?");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8399/inference");
  const form = calls[0].options.body;
  assert.equal(form.get("language"), "de");
  assert.equal(form.get("response_format"), "json");
  assert.equal(form.get("temperature"), "0.0");
  assert.ok(String(form.get("prompt")).includes("Felix Core"));
  assert.ok(String(form.get("prompt")).includes("FELIX_SYSTEM"));
});

// 2026-08-30 voice smoke test: a real spoken question containing these
// terms was mistranscribed and RAG correctly reported "nicht beantwortet"
// on the garbage result - the same question typed answered correctly, so
// the fix belongs at the STT vocabulary prompt, not in RAG/threshold/answer
// logic (see jarvis-transcribe-config.js). This pins the extended prompt so
// a future edit cannot silently drop these terms again.
test("the vocabulary prompt covers the Felix Core domain terms found missing in the 2026-08-30 voice smoke test", async () => {
  const { impl, calls } = fakeFetch();
  const service = createJarvisTranscribeService({ env: CONFIGURED_ENV, fetchImpl: impl });
  await service.transcribe({ audio: Buffer.from([1]), contentType: "audio/wav" });
  const prompt = String(calls[0].options.body.get("prompt"));
  for (const term of ["Google Sheet", "KI-Projektsteuerung", "sheet-update-gateway", "Single Source of Truth", "RAG", "Ollama", "Whisper", "Approval", "Run"]) {
    assert.ok(prompt.includes(term), `vocabulary prompt must include "${term}"`);
  }
});

test("strips a trailing slash from the configured base URL", async () => {
  const { impl, calls } = fakeFetch();
  const service = createJarvisTranscribeService({ env: { [WHISPER_SERVER_URL_ENV_VAR]: "http://127.0.0.1:8399/" }, fetchImpl: impl });
  await service.transcribe({ audio: Buffer.from([1]), contentType: "audio/wav" });
  assert.equal(calls[0].url, "http://127.0.0.1:8399/inference");
});

test("maps a network failure to WHISPER_UNAVAILABLE, retryable", async () => {
  const service = createJarvisTranscribeService({ env: CONFIGURED_ENV, fetchImpl: fakeFetch({ throwError: new Error("ECONNREFUSED") }).impl });
  await assert.rejects(
    () => service.transcribe({ audio: Buffer.from([1]), contentType: "audio/wav" }),
    (error) => error.code === "WHISPER_UNAVAILABLE" && error.retryable === true
  );
});

test("maps a non-ok HTTP response to WHISPER_UNAVAILABLE", async () => {
  const service = createJarvisTranscribeService({ env: CONFIGURED_ENV, fetchImpl: fakeFetch({ ok: false, status: 500 }).impl });
  await assert.rejects(
    () => service.transcribe({ audio: Buffer.from([1]), contentType: "audio/wav" }),
    (error) => error.code === "WHISPER_UNAVAILABLE"
  );
});

test("maps unparsable JSON to WHISPER_INVALID_RESPONSE", async () => {
  const service = createJarvisTranscribeService({ env: CONFIGURED_ENV, fetchImpl: fakeFetch({ json: new Error("not json") }).impl });
  await assert.rejects(
    () => service.transcribe({ audio: Buffer.from([1]), contentType: "audio/wav" }),
    (error) => error.code === "WHISPER_INVALID_RESPONSE"
  );
});

test("maps a response with no text field to WHISPER_INVALID_RESPONSE", async () => {
  const service = createJarvisTranscribeService({ env: CONFIGURED_ENV, fetchImpl: fakeFetch({ json: { segments: [] } }).impl });
  await assert.rejects(
    () => service.transcribe({ audio: Buffer.from([1]), contentType: "audio/wav" }),
    (error) => error.code === "WHISPER_INVALID_RESPONSE"
  );
});

test("trims whitespace and truncates an oversized transcript defensively", async () => {
  const longText = "  " + "a".repeat(JARVIS_TRANSCRIBE_MAX_TEXT_CHARS + 500) + "  ";
  const service = createJarvisTranscribeService({ env: CONFIGURED_ENV, fetchImpl: fakeFetch({ json: { text: longText } }).impl });
  const result = await service.transcribe({ audio: Buffer.from([1]), contentType: "audio/wav" });
  assert.equal(result.text.length, JARVIS_TRANSCRIBE_MAX_TEXT_CHARS);
  assert.ok(!result.text.startsWith(" "));
});

// 2026-08-30 voice smoke test, real failure: a spoken question was
// transcribed correctly (63 chars, right words) but the auto-submitted
// request was rejected with VALIDATION_FAILED ("hoechstens 500 Zeichen,
// eine Zeile, ..."). Traced to whisper-server returning an internal
// segment-break newline that survived the old `.trim()`-only handling and
// hit the knowledge-contract's single-line rule (hasControlCharacters in
// cc-context-fields.js) - a real, deliberate security/shape rule that is
// NOT changed here. The fix is this service normalizing its own STT output
// before it ever reaches that shared validator.
test("collapses an internal newline from whisper-server into a single space", async () => {
  const { impl } = fakeFetch({ json: { text: "Welche Komponente darf als einzige ins Google Sheet\nschreiben?" } });
  const service = createJarvisTranscribeService({ env: CONFIGURED_ENV, fetchImpl: impl });
  const result = await service.transcribe({ audio: Buffer.from([1]), contentType: "audio/wav" });
  assert.equal(result.text, "Welche Komponente darf als einzige ins Google Sheet schreiben?");
  assert.ok(!/[\r\n]/.test(result.text), "no control character (\\r or \\n) may survive into the outgoing text");
});

test("normalizeTranscript collapses CRLF, bare LF, repeated whitespace and trims edges", () => {
  const { normalizeTranscript } = transcribeInternals;
  assert.equal(normalizeTranscript("Google Sheet\nschreiben?"), "Google Sheet schreiben?");
  assert.equal(normalizeTranscript("Google Sheet\r\nschreiben?"), "Google Sheet schreiben?");
  assert.equal(normalizeTranscript("Google   Sheet\t\tschreiben?"), "Google Sheet schreiben?");
  assert.equal(normalizeTranscript("  Google Sheet schreiben?  ").trim(), "Google Sheet schreiben?");
});

test("aborts the request once the timeout elapses", async () => {
  const impl = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const service = createJarvisTranscribeService({ env: CONFIGURED_ENV, fetchImpl: impl, timeoutMs: 5 });
  await assert.rejects(
    () => service.transcribe({ audio: Buffer.from([1]), contentType: "audio/wav" }),
    (error) => error.code === "WHISPER_UNAVAILABLE"
  );
});
