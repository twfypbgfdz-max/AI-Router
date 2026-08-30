import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  buildAllowlistBlock,
  checkReadmeSync,
  applySync,
  README_BLOCK_START,
  README_BLOCK_END
} from "../orchestrator/knowledge/readme-allowlist-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const SAMPLE_DOCS = [
  { relativePath: "10_Apps/90_Entscheidungen/DEC-001-A.md", addedAt: "2026-07-29" },
  { relativePath: "10_Apps/90_Entscheidungen/DEC-002-B.md", addedAt: "2026-07-29" },
  { relativePath: "90_System/Profil.md", addedAt: "2026-08-11" }
];

test("buildAllowlistBlock renders count, latest addedAt as Stand-date and a contiguous DEC range", () => {
  const block = buildAllowlistBlock(SAMPLE_DOCS);
  assert.match(block, /3 freigegebene Dokumente/);
  assert.match(block, /Stand 11\.08\.2026/);
  assert.match(block, /DEC-001–DEC-002 \(vollständig, 2 Dokumente\)/);
  assert.match(block, /`90_System\/Profil\.md`/);
});

test("buildAllowlistBlock lists DEC numbers individually when they are not contiguous from DEC-001", () => {
  const docs = [
    { relativePath: "10_Apps/90_Entscheidungen/DEC-002-B.md", addedAt: "2026-07-29" },
    { relativePath: "10_Apps/90_Entscheidungen/DEC-004-D.md", addedAt: "2026-08-01" }
  ];
  const block = buildAllowlistBlock(docs);
  assert.match(block, /DEC-002, DEC-004/);
});

test("checkReadmeSync reports drift when the marked block does not match the allowlist", () => {
  const readmeText = `intro\n\n${README_BLOCK_START}\nstale content\n${README_BLOCK_END}\n\noutro`;
  const result = checkReadmeSync({ readmeText, documents: SAMPLE_DOCS });
  assert.equal(result.inSync, false);
  assert.equal(result.found, true);
});

test("applySync makes checkReadmeSync report in sync, without touching the surrounding text", () => {
  const readmeText = `intro\n\n${README_BLOCK_START}\nstale content\n${README_BLOCK_END}\n\noutro`;
  const updated = applySync({ readmeText, documents: SAMPLE_DOCS });
  const result = checkReadmeSync({ readmeText: updated, documents: SAMPLE_DOCS });
  assert.equal(result.inSync, true);
  assert.ok(updated.startsWith("intro\n\n"));
  assert.ok(updated.endsWith("\n\noutro"));
});

test("checkReadmeSync reports found:false when the markers are missing", () => {
  const result = checkReadmeSync({ readmeText: "no markers here", documents: SAMPLE_DOCS });
  assert.equal(result.found, false);
  assert.equal(result.inSync, false);
});

// Guard against exactly the bug this was built for: editing
// config/rag-allowlist.json (adding/removing a document) without
// re-running `npm run docs:sync-allowlist` now fails the test suite
// instead of silently leaving README.md wrong for weeks.
test("the real README.md allowlist block is in sync with the real config/rag-allowlist.json (npm run docs:check-allowlist)", () => {
  const result = spawnSync(process.execPath, ["scripts/sync-readme-allowlist.js", "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
