import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/live-text-response-smoke.js", import.meta.url));
const SAFE_SYSTEM_ENVIRONMENT = Object.freeze(
  Object.fromEntries(
    ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]
      .filter((name) => typeof process.env[name] === "string" && process.env[name])
      .map((name) => [name, process.env[name]])
  )
);

function diagnosticEnvironment(overrides = {}) {
  return {
    ...SAFE_SYSTEM_ENVIRONMENT,
    OPENAI_API_KEY: "fake-project-key-diagnostic-marker-0123456789",
    AI_ROUTER_INTERNAL_TOKEN: "fake-internal-token-diagnostic-marker-0123456789",
    AI_ROUTER_OPENAI_MODEL: "gpt-5.4-mini",
    AI_ROUTER_OPENAI_INPUT_USD_PER_MILLION_TOKENS: "0.75",
    AI_ROUTER_OPENAI_OUTPUT_USD_PER_MILLION_TOKENS: "4.50",
    AI_ROUTER_MAX_COST_USD: "0.02",
    ...overrides
  };
}

function diagnose(env) {
  return spawnSync(process.execPath, [SCRIPT_PATH, "--diagnose-config"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
    encoding: "utf8",
    windowsHide: true
  });
}

test("configuration diagnosis accepts the reviewed model and decimal prices without provider work", () => {
  const result = diagnose(diagnosticEnvironment());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /kein Providerrequest/);
  assert.match(result.stdout, /Konfiguration: akzeptiert/);
});

test("configuration diagnosis identifies the missing price field without exposing credentials", () => {
  const env = diagnosticEnvironment();
  delete env.AI_ROUTER_OPENAI_OUTPUT_USD_PER_MILLION_TOKENS;
  const result = diagnose(env);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 20);
  assert.match(output, /OPENAI_OUTPUT_USD_PER_MILLION_TOKENS: fehlt/);
  assert.match(output, /Reason=openai_output_price_missing/);
  assert.equal(output.includes(env.OPENAI_API_KEY), false);
  assert.equal(output.includes(env.AI_ROUTER_INTERNAL_TOKEN), false);
});
