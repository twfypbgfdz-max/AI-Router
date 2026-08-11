// Manual-only entry point: `npm run knowledge:parity`. Compares the
// Command Center knowledge route against the generic one on a real index
// with the real local model, and reports whether any difference is
// attributable to the code path or to model sampling.
//
// Why this exists: the two routes share one engine (knowledge-service.js),
// but the model chooses which of the offered sources K1..K3 it actually
// cites, and that choice varies between runs on the SAME route. A naive
// single-shot A/B comparison therefore produces false alarms.
//
// What this script can and cannot prove:
// - It CAN prove the retrieval is identical: similarity values are compared
//   at full float precision, and retrieval is deterministic.
// - It CANNOT prove behavioural equality by itself. With a sampling model,
//   a small number of runs can show two disjoint sets purely by chance.
//   The deterministic proof lives in test/knowledge-parity.test.js, which
//   pins the adapter and asserts byte-identical payloads.
//
// Read-only: no re-index, no vault access, nothing written but stdout.
// A fresh handler instance per call gives each its own in-memory limiter,
// so the 1-request-per-60s budget does not force a wait between samples.
import { EventEmitter } from "node:events";
import { createCcKnowledgeHandler } from "../orchestrator/cc-knowledge-handler.js";
import { createKnowledgeHandler } from "../orchestrator/knowledge-handler.js";
import { KNOWLEDGE_TOKEN_ENV_VAR } from "../orchestrator/knowledge-config.js";

const DEFAULT_QUESTION = "Welche Rolle hat der AI-Router laut der Architekturentscheidung zu Rollen, Verantwortlichkeiten und Grenzen?";

function parseArgs(argv) {
  const args = { question: DEFAULT_QUESTION, runs: 3 };
  for (const raw of argv) {
    const [flag, value] = raw.split("=");
    if (flag === "--question" && value) args.question = value;
    else if (flag === "--runs" && value) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--runs expects a positive integer.");
      args.runs = parsed;
    } else throw new Error(`Unknown argument: ${raw}`);
  }
  return args;
}

function exchange(body, token) {
  const request = new EventEmitter();
  request.method = "POST";
  request.headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  request.socket = new EventEmitter();
  queueMicrotask(() => { request.emit("data", JSON.stringify(body)); request.emit("end"); });

  const response = new EventEmitter();
  response.headers = new Map();
  response.statusCode = 200;
  response.writableEnded = false;
  response.destroyed = false;
  response.body = "";
  response.setHeader = (name, value) => response.headers.set(String(name).toLowerCase(), String(value));
  response.getHeader = (name) => response.headers.get(String(name).toLowerCase());
  response.end = (value = "") => { response.body = String(value); response.writableEnded = true; };
  return { request, response };
}

const silentLogger = { log() {} };

async function callOnce(kind, question) {
  const handler = kind === "cc"
    ? createCcKnowledgeHandler({ eventLogger: silentLogger })
    : createKnowledgeHandler({ eventLogger: silentLogger });
  const token = kind === "cc" ? process.env.AI_ROUTER_CC_TOKEN : process.env[KNOWLEDGE_TOKEN_ENV_VAR];
  const { request, response } = exchange({ schemaVersion: "1.0", question }, token);
  await handler(request, response);
  return { status: response.statusCode, payload: JSON.parse(response.body) };
}

// Everything the pipeline decides deterministically. The answer text is
// deliberately excluded - that is the part the model samples.
function fingerprint(payload) {
  return JSON.stringify({
    state: payload.state,
    systemContextState: payload.systemContextState,
    knowledgeState: payload.knowledgeState,
    warnings: payload.warnings,
    sources: (payload.sources || []).map((s) => [s.sourceDoc, s.section, s.similarity, s.docStatus, s.docVersion, s.freshness])
  });
}

// Every distinct (sourceDoc, section) -> similarity pair either route ever
// produced. Retrieval is deterministic, so one document/section must always
// carry the same similarity - a mismatch here is a genuine retrieval
// difference and the one unambiguous failure signal this script can give.
function similarityIndex(samples) {
  const index = new Map();
  const conflicts = [];
  for (const sample of samples) {
    for (const source of sample.payload.sources || []) {
      const key = `${source.sourceDoc}||${source.section}`;
      if (!index.has(key)) index.set(key, source.similarity);
      else if (index.get(key) !== source.similarity) {
        conflicts.push({ key, seen: index.get(key), now: source.similarity });
      }
    }
  }
  return { index, conflicts };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.AI_ROUTER_CC_TOKEN) throw new Error("AI_ROUTER_CC_TOKEN is not set in this process.");
  if (!process.env[KNOWLEDGE_TOKEN_ENV_VAR]) throw new Error(`${KNOWLEDGE_TOKEN_ENV_VAR} is not set in this process.`);

  console.log(`Frage: ${args.question}`);
  console.log(`Läufe je Route: ${args.runs}\n`);

  const samples = { cc: [], generic: [] };
  for (let run = 1; run <= args.runs; run += 1) {
    for (const kind of ["cc", "generic"]) {
      const { status, payload } = await callOnce(kind, args.question);
      if (status !== 200) throw new Error(`${kind} run ${run} returned HTTP ${status}: ${payload?.error?.code || "unknown"}`);
      samples[kind].push({ run, payload, fingerprint: fingerprint(payload) });
      const sources = (payload.sources || []).map((s) => `${s.sourceDoc.split("/").pop()}@${s.similarity.toFixed(6)}`).join("  ");
      console.log(`${kind === "cc" ? "cc/knowledge " : "v1/knowledge"} Lauf ${run}: state=${payload.state} Antwortlänge=${payload.answer?.length ?? 0}`);
      console.log(`                    Quellen: ${sources || "(keine)"}`);
    }
  }

  const all = [...samples.cc, ...samples.generic];
  const { index, conflicts } = similarityIndex(all);
  const ccPrints = new Set(samples.cc.map((s) => s.fingerprint));
  const genericPrints = new Set(samples.generic.map((s) => s.fingerprint));
  const sharedPrints = [...ccPrints].filter((print) => genericPrints.has(print));

  console.log("\n--- Auswertung ---");
  console.log(`Verschiedene Fingerabdrücke: cc/knowledge ${ccPrints.size}, v1/knowledge ${genericPrints.size}, gemeinsam ${sharedPrints.length}`);
  console.log(`Verschiedene Antworttexte:   cc/knowledge ${new Set(samples.cc.map((s) => s.payload.answer)).size}, v1/knowledge ${new Set(samples.generic.map((s) => s.payload.answer)).size}`);
  console.log(`Geprüfte Quelle/Similarity-Paare: ${index.size}`);

  if (conflicts.length > 0) {
    console.log("\nERGEBNIS: ABWEICHUNG. Dieselbe Quelle/Abschnitt hat unterschiedliche Similarity-Werte:");
    for (const conflict of conflicts) console.log(`  ${conflict.key}: ${conflict.seen} vs ${conflict.now}`);
    console.log("Retrieval ist deterministisch - das ist ein echter Unterschied, kein Rauschen.");
    return 1;
  }

  console.log("\nRetrieval identisch: jede Quelle trägt auf beiden Routen denselben Similarity-Wert");
  console.log("auf volle Gleitkomma-Genauigkeit.");

  if (ccPrints.size === 1 && genericPrints.size === 1 && sharedPrints.length === 1) {
    console.log("ERGEBNIS: identisch. Beide Routen lieferten in allen Läufen denselben");
    console.log("deterministischen Anteil; Unterschiede gibt es nur im Antworttext.");
    return 0;
  }
  if (sharedPrints.length > 0) {
    console.log("ERGEBNIS: identisch im Rahmen des Modell-Rauschens. Mindestens ein Fingerabdruck");
    console.log("tritt auf BEIDEN Routen auf, und die Menge variiert auch INNERHALB einer Route -");
    console.log("das ist die Auswahl der zitierten Quellen durch das Modell, nicht der Codepfad.");
    return 0;
  }
  console.log("ERGEBNIS: UNKLAR. Die Fingerabdrücke der beiden Routen überschneiden sich nicht.");
  console.log("Das kann bei wenigen Läufen auch Zufall sein - mit --runs=8 wiederholen, bevor");
  console.log("daraus eine Abweichung geschlossen wird. Der deterministische Nachweis ist");
  console.log("test/knowledge-parity.test.js.");
  return 2;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`Knowledge parity check failed: ${error.message}`);
  process.exitCode = 1;
}
