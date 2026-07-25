import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createRouterServer } from "../orchestrator/server.js";
import {
  loadOpenAITextProviderConfig,
  loadTextResponseProtectionConfig
} from "../orchestrator/text-response-config.js";
import { createTextResponseHandler } from "../orchestrator/text-response-handler.js";
import { isSafeTextResponseReasonCode } from "../orchestrator/text-response-response.js";
import { authenticateInternalRequest } from "../orchestrator/internal-auth.js";
import { createOpenAITextAdapter } from "../orchestrator/provider-adapters/openai-text.js";

const LOOPBACK_HOST = "127.0.0.1";
const REQUIRED_ENVIRONMENT = Object.freeze([
  "OPENAI_API_KEY",
  "AI_ROUTER_INTERNAL_TOKEN",
  "AI_ROUTER_OPENAI_MODEL",
  "AI_ROUTER_OPENAI_INPUT_USD_PER_MILLION_TOKENS",
  "AI_ROUTER_OPENAI_OUTPUT_USD_PER_MILLION_TOKENS",
  "AI_ROUTER_MAX_COST_USD"
]);
const EXIT = Object.freeze({
  ok: 0,
  environment: 20,
  usage: 21,
  serverStart: 30,
  request: 40,
  unexpected: 50,
  cleanup: 60
});
const RESPONSE_FIELDS = Object.freeze([
  "answer", "error", "meta", "provider", "requestId", "route", "schemaVersion", "status"
]);
const ROUTE_FIELDS = Object.freeze(["name", "taskType"]);
const ANSWER_FIELDS = Object.freeze(["text", "truncated", "trust", "type"]);
const PROVIDER_FIELDS = Object.freeze(["model", "providerId"]);
const META_FIELDS = Object.freeze([
  "actionsExecuted",
  "calculatedCostUsd",
  "durationMs",
  "inputTokenEstimate",
  "providerInputTokens",
  "providerOutputTokens",
  "providerTotalTokens",
  "toolCallingAllowed",
  "worstCaseCostUsd"
]);
const ROUTE_NAMES = new Set([
  "analysis", "content_generation", "general_chat", "knowledge_query", "planning"
]);
const TASK_TYPES = new Set([
  "code", "research", "planning", "writing", "obsidian", "social_media",
  "learning", "career", "finance", "everyday", "unknown"
]);
const SAFE_CONFIGURATION_FIELDS = new Map([
  ["AI_ROUTER_OPENAI_INPUT_USD_PER_MILLION_TOKENS", "openai_input_price"],
  ["AI_ROUTER_OPENAI_OUTPUT_USD_PER_MILLION_TOKENS", "openai_output_price"],
  ["AI_ROUTER_MAX_COST_USD", "max_cost"],
  ["AI_ROUTER_PROVIDER_TIMEOUT_MS", "provider_timeout"],
  ["AI_ROUTER_MAX_REQUESTS_PER_MINUTE", "request_rate_limit"],
  ["AI_ROUTER_MAX_CONCURRENT_REQUESTS", "concurrency_limit"]
]);

class SmokeFailure extends Error {
  constructor(exitCode, safeMessage) {
    super(safeMessage);
    this.name = "SmokeFailure";
    this.exitCode = exitCode;
  }
}

function isPresent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function fakeEnvironment() {
  return Object.freeze({
    OPENAI_API_KEY: "fake-key-used-only-by-local-smoke-provider",
    AI_ROUTER_INTERNAL_TOKEN: "fake-internal-token-used-only-by-local-smoke-provider",
    AI_ROUTER_OPENAI_MODEL: "fake-local-smoke-model",
    AI_ROUTER_OPENAI_INPUT_USD_PER_MILLION_TOKENS: "1",
    AI_ROUTER_OPENAI_OUTPUT_USD_PER_MILLION_TOKENS: "1",
    AI_ROUTER_MAX_COST_USD: "0.01"
  });
}

function reportEnvironment(env) {
  let complete = true;
  for (const name of REQUIRED_ENVIRONMENT) {
    const present = isPresent(env[name]);
    console.log(`${name}: ${present ? "vorhanden" : "fehlt"}`);
    complete &&= present;
  }
  return complete;
}

function safeResponseReason(payload) {
  const reason = payload?.error?.reasonCode;
  return isSafeTextResponseReasonCode(reason) ? reason : "not_available";
}

function safeLocalConfigurationReason(error) {
  if (error?.code === "AUTH_NOT_CONFIGURED") return "internal_token_invalid";
  const reason = error?.safeDetails?.reason;
  const fieldAlias = SAFE_CONFIGURATION_FIELDS.get(error?.safeDetails?.field);
  if (reason === "cost_configuration_missing" && fieldAlias) return `${fieldAlias}_missing`;
  if (reason === "cost_configuration_invalid" && fieldAlias) return `${fieldAlias}_invalid`;
  if (reason === "protection_configuration_invalid" && fieldAlias) return `${fieldAlias}_invalid`;
  if (isSafeTextResponseReasonCode(reason)) return reason;
  if (error?.code === "PROVIDER_NOT_CONFIGURED") return "adapter_configuration_invalid";
  return "not_available";
}

function diagnoseConfiguration(env) {
  console.log("Modus: lokale Konfigurationsdiagnose (kein Providerrequest)");
  const environmentComplete = reportEnvironment(env);
  try {
    authenticateInternalRequest(`Bearer ${env.AI_ROUTER_INTERNAL_TOKEN}`, {
      expectedToken: env.AI_ROUTER_INTERNAL_TOKEN
    });
    loadTextResponseProtectionConfig(env);
    const providerConfig = loadOpenAITextProviderConfig(env);
    createOpenAITextAdapter(providerConfig);
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
    throw new SmokeFailure(
      EXIT.environment,
      `Konfiguration abgelehnt: Code=${code}; Reason=${safeLocalConfigurationReason(error)}.`
    );
  }
  if (!environmentComplete) {
    throw new SmokeFailure(EXIT.environment, "Mindestens eine erforderliche Umgebungsvariable fehlt.");
  }
  console.log("Konfiguration: akzeptiert.");
  console.log("Gesamtergebnis: bestanden; Exitcode=0");
}

function exactFields(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function nonNegativeNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertScenarioSemantics(answerText, scenario, unexpected) {
  const normalized = answerText.normalize("NFKC").toLowerCase();
  if (scenario.requiredAnswerTerms
    && !scenario.requiredAnswerTerms.some((term) => normalized.includes(term))) {
    unexpected("scenario semantics");
  }
  if (scenario.requiresMissingContextDisclosure) {
    const absenceTerms = [
      "nicht", "kein", "keine", "ohne", "fehlt", "unbekannt",
      "cannot", "can't", "missing", "not ", "no "
    ];
    const scopeTerms = [
      "kontext", "bereitgestellt", "übermittelt", "zugriff", "verifiz", "aktuellen stand",
      "context", "provided", "access", "verify", "current state"
    ];
    if (!absenceTerms.some((term) => normalized.includes(term))
      || !scopeTerms.some((term) => normalized.includes(term))) {
      unexpected("missing-context disclosure");
    }
  }
}

function assertSuccessfulContract(httpStatus, payload, scenario) {
  const unexpected = (field) => {
    throw new SmokeFailure(
      EXIT.unexpected,
      `${scenario.label}: unerwarteter Antwortvertrag (${field}).`
    );
  };

  if (httpStatus !== 200) {
    const safeCode = typeof payload?.error?.code === "string" ? payload.error.code : "kein_sicherer_code";
    throw new SmokeFailure(
      EXIT.unexpected,
      `${scenario.label}: HTTP ${httpStatus}, Router-Status ${String(payload?.status || "unbekannt")}, `
      + `Code ${safeCode}, Reason ${safeResponseReason(payload)}.`
    );
  }
  if (!exactFields(payload, RESPONSE_FIELDS)) unexpected("response");
  if (payload.schemaVersion !== "1.0") unexpected("schemaVersion");
  if (payload.requestId !== scenario.request.requestId) unexpected("requestId");
  if (payload.status !== "answered") unexpected("status");
  if (payload.error !== null) unexpected("error");

  if (!exactFields(payload.route, ROUTE_FIELDS)) unexpected("route");
  if (!ROUTE_NAMES.has(payload.route.name) || !TASK_TYPES.has(payload.route.taskType)) {
    unexpected("route values");
  }
  if (payload.route.name !== scenario.expectedRoute) unexpected("expected route");

  if (!exactFields(payload.answer, ANSWER_FIELDS)) unexpected("answer");
  if (payload.answer.type !== "text"
    || typeof payload.answer.text !== "string"
    || payload.answer.text.length < 1
    || payload.answer.text.length > 8_000
    || payload.answer.trust !== "untrusted_provider_text"
    || payload.answer.truncated !== false) {
    unexpected("answer values");
  }
  assertScenarioSemantics(payload.answer.text, scenario, unexpected);

  if (!exactFields(payload.provider, PROVIDER_FIELDS)
    || payload.provider.providerId !== "openai-text-v1"
    || payload.provider.model !== "server-configured") {
    unexpected("provider");
  }

  if (!exactFields(payload.meta, META_FIELDS)) unexpected("meta");
  if (!nonNegativeNumber(payload.meta.durationMs)
    || payload.meta.toolCallingAllowed !== false
    || payload.meta.actionsExecuted !== false
    || !nonNegativeInteger(payload.meta.inputTokenEstimate)
    || !nonNegativeInteger(payload.meta.providerInputTokens)
    || !nonNegativeInteger(payload.meta.providerOutputTokens)
    || !nonNegativeInteger(payload.meta.providerTotalTokens)
    || !nonNegativeNumber(payload.meta.worstCaseCostUsd)
    || payload.meta.worstCaseCostUsd > 0.02
    || !nonNegativeNumber(payload.meta.calculatedCostUsd)
    || payload.meta.calculatedCostUsd > payload.meta.worstCaseCostUsd) {
    unexpected("meta values");
  }
  if (payload.meta.providerTotalTokens
    !== payload.meta.providerInputTokens + payload.meta.providerOutputTokens) {
    unexpected("token totals");
  }
}

function printSafeSummary(httpStatus, payload, scenario) {
  const meta = payload.meta;
  console.log(
    `${scenario.label}: HTTP=${httpStatus} Status=${payload.status} `
    + `InputEstimate=${meta.inputTokenEstimate} ProviderInput=${meta.providerInputTokens} `
    + `ProviderOutput=${meta.providerOutputTokens} ProviderTotal=${meta.providerTotalTokens} `
    + `WorstCaseCostUsd=${meta.worstCaseCostUsd} CalculatedCostUsd=${meta.calculatedCostUsd}`
  );
}

function scenarios() {
  const runId = Date.now().toString(36);
  return Object.freeze([
    Object.freeze({
      label: "allgemeine_frage",
      expectedRoute: "knowledge_query",
      request: Object.freeze({
        schemaVersion: "1.0",
        requestId: `manual_smoke_general_${runId}`,
        source: "internal_test",
        intent: "general_question",
        input: Object.freeze({
          type: "text",
          content: "Erkläre in zwei kurzen Sätzen, was deterministisches Routing bedeutet."
        })
      })
    }),
    Object.freeze({
      label: "systemfrage_mit_kuenstlichem_kontext",
      expectedRoute: "knowledge_query",
      requiredAnswerTerms: Object.freeze(["grün", "green"]),
      request: Object.freeze({
        schemaVersion: "1.0",
        requestId: `manual_smoke_context_${runId}`,
        source: "internal_test",
        intent: "project_status_summary",
        input: Object.freeze({
          type: "text",
          content: "Fasse ausschließlich den übermittelten künstlichen Teststand kurz zusammen."
        }),
        context: Object.freeze({
          type: "text",
          content: "Künstlicher Testkontext: Der AI-Router-Demostand meldet den Zustand Grün. Dies ist kein echter Live-Status.",
          containsPrivateData: false,
          privacyLevel: "external-provider-allowed",
          sourceLabel: "manual-live-smoke-artificial-context",
          capturedAt: new Date().toISOString()
        })
      })
    }),
    Object.freeze({
      label: "interne_frage_ohne_kontext",
      expectedRoute: "analysis",
      requiresMissingContextDisclosure: true,
      request: Object.freeze({
        schemaVersion: "1.0",
        requestId: `manual_smoke_no_context_${runId}`,
        source: "internal_test",
        intent: "project_status_summary",
        input: Object.freeze({
          type: "text",
          content: "Wie ist der aktuelle interne Zustand des AI-Routers in Felix' System?"
        })
      })
    })
  ]);
}

function fakeAdapterFactory() {
  return Object.freeze({
    async generateText({ question, context }) {
      const text = context
        ? "Der ausdrücklich übermittelte künstliche Teststand ist Grün."
        : question.includes("aktuelle interne Zustand")
          ? "Ohne ausdrücklich übermittelten Kontext ist kein aktueller interner Stand verifizierbar."
          : "Deterministisches Routing wählt bei gleicher Eingabe nach festen Regeln denselben Pfad.";
      return Object.freeze({
        text,
        usage: Object.freeze({
          inputTokens: 120,
          outputTokens: 24,
          totalTokens: 144
        })
      });
    }
  });
}

function childEnvironment(fakeMode, env) {
  if (!fakeMode) return { ...env };
  const result = {};
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
    if (isPresent(env[name])) result[name] = env[name];
  }
  return { ...result, ...fakeEnvironment() };
}

async function runServerChild(fakeMode) {
  const env = fakeMode ? fakeEnvironment() : process.env;
  const textResponseHandler = createTextResponseHandler({
    env,
    adapterFactory: fakeMode ? fakeAdapterFactory : undefined,
    metadataLogger: Object.freeze({ logOutcome() {} })
  });
  const eventLogger = Object.freeze({ async log() {} });
  const server = createRouterServer({ textResponseHandler, eventLogger });
  let stopping = false;
  const stop = (exitCode = EXIT.ok) => {
    if (stopping) return;
    stopping = true;
    const forcedExit = setTimeout(() => process.exit(EXIT.cleanup), 3_000);
    forcedExit.unref();
    server.close(() => {
      clearTimeout(forcedExit);
      process.exit(exitCode);
    });
    server.closeAllConnections?.();
  };

  process.once("message", (message) => {
    if (message?.type === "shutdown") stop();
  });
  process.once("SIGTERM", () => stop());
  process.once("SIGINT", () => stop());
  server.once("error", () => {
    process.send?.({ type: "failed" });
    stop(EXIT.serverStart);
  });
  server.listen(0, LOOPBACK_HOST, () => {
    const address = server.address();
    if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST) {
      process.send?.({ type: "failed" });
      stop(EXIT.serverStart);
      return;
    }
    process.send?.({ type: "ready", port: address.port });
  });
}

async function startServerProcess(fakeMode, env) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--server-child", ...(fakeMode ? ["--fake-provider"] : [])],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: childEnvironment(fakeMode, env),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    }
  );
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SmokeFailure(
      EXIT.serverStart,
      "Routerprozess wurde nicht rechtzeitig bereit."
    )), 5_000);
    timer.unref();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new SmokeFailure(EXIT.serverStart, "Routerprozess konnte nicht gestartet werden."));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new SmokeFailure(EXIT.serverStart, "Routerprozess endete vor dem Smoke-Test."));
    });
    child.once("message", (message) => {
      clearTimeout(timer);
      if (message?.type === "ready" && Number.isSafeInteger(message.port) && message.port > 0) {
        resolve(message.port);
      } else {
        reject(new SmokeFailure(EXIT.serverStart, "Routerprozess meldete keinen sicheren Bereitschaftsstatus."));
      }
    });
  });
  return Object.freeze({ child, baseUrl: `http://${LOOPBACK_HOST}:${ready}` });
}

async function stopServerProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.send?.({ type: "shutdown" });
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3_000);
      timer.unref();
    })
  ]);
  if (graceful) return;
  child.kill();
  const forced = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3_000);
      timer.unref();
    })
  ]);
  if (!forced) {
    throw new SmokeFailure(EXIT.cleanup, "Routerprozess konnte nicht zuverlässig beendet werden.");
  }
}

async function postOnce(baseUrl, token, scenario) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(`${baseUrl}/api/router/respond`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(scenario.request),
      signal: controller.signal
    });
    let payload;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      throw new SmokeFailure(EXIT.unexpected, `${scenario.label}: Antwort war kein gültiges JSON.`);
    }
    return Object.freeze({ httpStatus: response.status, payload });
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    throw new SmokeFailure(EXIT.request, `${scenario.label}: Request fehlgeschlagen oder ist abgelaufen.`);
  } finally {
    clearTimeout(timer);
  }
}

async function runController(fakeMode) {
  const env = fakeMode ? fakeEnvironment() : process.env;
  console.log(`Modus: ${fakeMode ? "Fake-Provider (kein externer Netzwerkzugriff)" : "Live"}`);
  if (!reportEnvironment(env)) {
    throw new SmokeFailure(EXIT.environment, "Mindestens eine erforderliche Umgebungsvariable fehlt.");
  }

  let serverProcess = null;
  let primaryFailure = null;
  try {
    serverProcess = await startServerProcess(fakeMode, process.env);
    const testScenarios = scenarios();
    if (testScenarios.length > 3) {
      throw new SmokeFailure(EXIT.usage, "Mehr als drei Smoke-Test-Requests sind nicht erlaubt.");
    }
    for (const scenario of testScenarios) {
      const result = await postOnce(serverProcess.baseUrl, env.AI_ROUTER_INTERNAL_TOKEN, scenario);
      assertSuccessfulContract(result.httpStatus, result.payload, scenario);
      printSafeSummary(result.httpStatus, result.payload, scenario);
    }
  } catch (error) {
    primaryFailure = error instanceof SmokeFailure
      ? error
      : new SmokeFailure(EXIT.unexpected, "Unerwarteter Smoke-Test-Fehler.");
    throw primaryFailure;
  } finally {
    try {
      await stopServerProcess(serverProcess?.child);
    } catch (cleanupError) {
      if (!primaryFailure) throw cleanupError;
      throw new SmokeFailure(EXIT.cleanup, "Smoke-Test und Routerprozess-Bereinigung sind fehlgeschlagen.");
    }
  }
  console.log("Gesamtergebnis: bestanden; Exitcode=0");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const childMode = args.delete("--server-child");
  const fakeMode = args.delete("--fake-provider");
  const diagnoseMode = args.delete("--diagnose-config");
  if (args.size > 0) {
    throw new SmokeFailure(EXIT.usage, "Unbekannte Befehlsoption.");
  }
  if (diagnoseMode) {
    if (childMode || fakeMode) {
      throw new SmokeFailure(EXIT.usage, "Konfigurationsdiagnose kann nicht mit anderen Modi kombiniert werden.");
    }
    diagnoseConfiguration(process.env);
    return;
  }
  if (childMode) {
    await runServerChild(fakeMode);
    return;
  }
  await runController(fakeMode);
}

main().catch((error) => {
  const failure = error instanceof SmokeFailure
    ? error
    : new SmokeFailure(EXIT.unexpected, "Unerwarteter Smoke-Test-Fehler.");
  console.error(`Gesamtergebnis: fehlgeschlagen; Exitcode=${failure.exitCode}; ${failure.message}`);
  process.exitCode = failure.exitCode;
});
