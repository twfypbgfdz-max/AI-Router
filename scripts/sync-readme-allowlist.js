// Manual-only entry point, same discipline as rag-dec-coverage.js /
// rag-quality-eval.js: never runs automatically, never touches the vault,
// only reads config/rag-allowlist.json and writes or checks the one marked
// block in README.md. DEC-003 section 5 forbids an automation from
// silently overwriting existing permanent documentation - `npm run
// docs:sync-allowlist` requires a human to run it and review the diff
// before committing; `npm run docs:check-allowlist` (also used by the test
// suite) only reports drift, it never writes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDocumentsFromAllowlist, checkReadmeSync, applySync } from "../orchestrator/knowledge/readme-allowlist-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.join(__dirname, "..", "README.md");

const checkOnly = process.argv.includes("--check");
const documents = loadDocumentsFromAllowlist();
const readmeText = fs.readFileSync(README_PATH, "utf8");
const result = checkReadmeSync({ readmeText, documents });

if (result.inSync) {
  console.log("README.md allowlist block is in sync with config/rag-allowlist.json.");
  process.exitCode = 0;
} else if (checkOnly) {
  console.error(
    result.found
      ? "README.md allowlist block is out of sync with config/rag-allowlist.json. Run `npm run docs:sync-allowlist`."
      : "README.md is missing the readme-allowlist-sync markers - add them once around the Allowlist bullet, then run `npm run docs:sync-allowlist`."
  );
  process.exitCode = 1;
} else {
  const updated = applySync({ readmeText, documents });
  fs.writeFileSync(README_PATH, updated);
  console.log("README.md allowlist block updated from config/rag-allowlist.json.");
  process.exitCode = 0;
}
