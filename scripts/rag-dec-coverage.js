// Manual-only entry point: `npm run rag:dec-coverage`. Strictly read-only,
// same discipline as rag-quality-eval.js and rag-truth-eval.js: never
// re-indexes, never touches the allowlist file, never writes into the
// vault. It only compares the Accepted DEC documents in FELIX_SYSTEM
// against config/rag-allowlist.json and reports the gap.
import { computeDecCoverage } from "../orchestrator/knowledge/rag-dec-coverage.js";

const vaultRoot = typeof process.env.AI_ROUTER_VAULT_ROOT === "string" ? process.env.AI_ROUTER_VAULT_ROOT.trim() : "";

if (!vaultRoot) {
  console.error("AI_ROUTER_VAULT_ROOT is not set.");
  process.exitCode = 1;
} else {
  try {
    const result = computeDecCoverage({ vaultRoot });
    console.log("RAG DEC coverage:");
    console.log(`${result.totalValid} valid decisions`);
    console.log(`${result.totalAllowlisted} allowlisted`);
    console.log(`${result.missing.length} missing`);
    if (result.missing.length > 0) {
      console.log("Missing:");
      for (const relativePath of result.missing) console.log(`- ${relativePath}`);
    }
    console.log(result.pass ? "PASS" : "FAIL");
    process.exitCode = result.pass ? 0 : 1;
  } catch (error) {
    console.error(`RAG DEC coverage failed: ${error.message}`);
    process.exitCode = 1;
  }
}
