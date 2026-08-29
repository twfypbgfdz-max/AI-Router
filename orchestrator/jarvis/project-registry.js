// J1.1 - Project Resolution. A small, closed allowlist that maps a natural
// German project reference ("Router", "Mach beim AI-Router weiter") to
// exactly one known local repository, or explicitly refuses to guess.
//
// Why this file exists rather than reading felix-command-center's
// config/projects.local.json at runtime: that file lists id/name/path but
// has no alias field today, and it lives in a separate repository/process
// (CommonJS, its own git-safety boundary) that this ESM orchestrator has no
// existing dependency on - the only real cross-repo link today is the
// narrow, unrelated GET /api/companion/status contract in
// command-center-client.js. Reading another repo's file straight off disk
// would be a new architectural dependency, not a small additive slice, so
// J1.1 keeps its own closed registry instead and accepts the duplication.
// The ids and paths below are intentionally kept identical to
// felix-command-center/config/projects.local.json so the two stay easy to
// diff by hand; a later step could replace this with a real shared source
// once Felix decides how that link should work (see session handoff
// 2026-08-29-j1-jarvis-audit-korrektur.md).
//
// Default-deny, same as action-registry.js: an unresolved or ambiguous
// reference NEVER falls back to a guessed path. There is no fuzzy/edit-
// distance matching - only exact, hand-curated aliases per project.
import { normalizeClassificationText } from "../task-classifier.js";

// One entry per known local repository. `aliases` must be exhaustive by
// hand - every alias Felix is expected to actually say - not derived from
// the name automatically, to keep the mapping auditable at a glance.
const PROJECT_DEFINITIONS = Object.freeze([
  {
    id: "ai-router",
    name: "AI-Router",
    path: "C:\\Users\\felil\\Documents\\KI\\AI-Router",
    aliases: ["ai-router", "airouter", "ai router", "router", "der router"]
  },
  {
    id: "felix-command-center",
    name: "Felix Command Center",
    path: "C:\\Users\\felil\\Documents\\KI\\felix-command-center",
    aliases: ["felix command center", "command center", "commandcenter", "das command center"]
  },
  {
    id: "felix-cockpit",
    name: "Felix Cockpit",
    path: "C:\\Users\\felil\\Documents\\KI\\felix-cockpit",
    aliases: ["felix cockpit", "cockpit", "das cockpit"]
  },
  {
    id: "coaching-hub",
    name: "Coaching-Hub",
    path: "C:\\Users\\felil\\Documents\\KI\\Felix-Coaching-Hub",
    aliases: ["coaching hub", "coaching-hub", "coachinghub"]
  },
  {
    id: "app",
    name: "Plateau-Brecher Personal",
    path: "C:\\Users\\felil\\Documents\\KI\\App",
    aliases: ["plateau-brecher personal", "personal app", "die personal app"]
  },
  {
    id: "public-app",
    name: "Public-App",
    path: "C:\\Users\\felil\\Documents\\KI\\Public-Brecher",
    aliases: ["public app", "public-app", "die public app"]
  }
]);

// Aliases that are genuinely ambiguous between two or more real projects
// today (R2/R4-style: recognized, but never guessed). Kept separate from
// PROJECT_DEFINITIONS so each project's own alias list can stay unambiguous
// by construction; adding the same alias to two projects above would be a
// silent authoring bug, this list is the one place ambiguity is explicit.
const AMBIGUOUS_ALIASES = Object.freeze({
  "plateau-brecher": ["app", "public-app"],
  "plateau brecher": ["app", "public-app"],
  "trainingsapp": ["app", "public-app"],
  "die trainingsapp": ["app", "public-app"],
  // "Felix Core" is used loosely for the whole system (vault + AI-Router +
  // Command Center + Cockpit together), not one repository - resolving it
  // to any single path would be a guess, not a resolution.
  "felix core": []
});

function normalize(value) {
  return normalizeClassificationText(value).replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, " ").trim();
}

const byId = new Map(PROJECT_DEFINITIONS.map((project) => [project.id, project]));
const aliasIndex = new Map();
for (const project of PROJECT_DEFINITIONS) {
  for (const alias of project.aliases) {
    const key = normalize(alias);
    if (!key) continue;
    if (aliasIndex.has(key) && aliasIndex.get(key) !== project.id) {
      throw new Error(`project-registry: alias "${alias}" is claimed by more than one project - move it to AMBIGUOUS_ALIASES instead.`);
    }
    aliasIndex.set(key, project.id);
  }
  // The bare id and bare name are always valid references too.
  aliasIndex.set(normalize(project.id), project.id);
  aliasIndex.set(normalize(project.name), project.id);
}

function projectView(id) {
  const project = byId.get(id);
  return project ? Object.freeze({ id: project.id, name: project.name, path: project.path }) : null;
}

// Resolves a free-text project mention against the closed registry.
// Returns exactly one of four shapes, never a guessed path:
//   { status: "none" }                      - no project mentioned at all
//   { status: "resolved", project }         - exactly one known project
//   { status: "ambiguous", candidates }     - known alias, >1 real project
//   { status: "unknown", mention }          - text present, matches nothing
//
// `text` should be the raw user utterance (or a candidate substring); this
// function does not try to extract a mention from a full sentence itself -
// that segmentation is the caller's job (see request-planner.js), kept
// separate so this module stays a pure, testable lookup table.
export function resolveProject(text) {
  const key = normalize(text);
  if (!key) return Object.freeze({ status: "none" });
  if (Object.hasOwn(AMBIGUOUS_ALIASES, key)) {
    const candidateIds = AMBIGUOUS_ALIASES[key];
    if (!candidateIds.length) return Object.freeze({ status: "unknown", mention: text.trim() });
    return Object.freeze({ status: "ambiguous", candidates: Object.freeze(candidateIds.map(projectView)) });
  }
  const id = aliasIndex.get(key);
  if (!id) return Object.freeze({ status: "unknown", mention: text.trim() });
  return Object.freeze({ status: "resolved", project: projectView(id) });
}

// Ordered longest-alias-first so "felix command center" wins over a
// coincidental shorter overlap before "cockpit" is tried, etc. Exposed
// mainly so request-planner.js can scan a free-form sentence for the
// longest known mention instead of matching only the whole string.
export function knownMentions() {
  return [...aliasIndex.keys(), ...Object.keys(AMBIGUOUS_ALIASES)].sort((a, b) => b.length - a.length);
}

export function listProjects() {
  return PROJECT_DEFINITIONS.map((project) => projectView(project.id));
}

export const projectRegistryInternals = Object.freeze({ normalize, PROJECT_DEFINITIONS, AMBIGUOUS_ALIASES });
