// Manual-only entry point: `npm run rag:reindex`. No scheduler, no watcher,
// never invoked automatically from orchestrator/server.js or npm start.
import { runRagReindex } from "../orchestrator/knowledge/rag-indexer.js";
import { RagError } from "../orchestrator/knowledge/rag-error.js";

try {
  const result = await runRagReindex();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 0;
} catch (error) {
  if (error instanceof RagError) {
    console.error(`RAG reindex failed: ${error.code} - ${error.message}`);
  } else {
    console.error("RAG reindex failed with an unexpected error.", error);
  }
  process.exitCode = 1;
}
