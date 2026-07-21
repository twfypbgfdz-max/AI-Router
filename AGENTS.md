## Vercel-Deploy-Regel (AI-Router / ai-router-preview)

**Niemals `vercel deploy --yes` ohne explizites Target ausführen.**

Grund: `ai-router-preview` ist NICHT mit einem Git-Repository verknüpft. Ohne
explizites `--target` deployt die Vercel-CLI standardmäßig als **Production**,
unabhängig vom Projektnamen. "Preview" im Projektnamen hat keinerlei Einfluss
auf das tatsächliche Deployment-Target.

**Verbindlich:**
- Preview-Deployment: `vercel deploy --target=preview`
- Production-Deployment: nur nach ausdrücklicher, expliziter Freigabe durch
  Felix — niemals implizit über einen Default-Aufruf.
- Vor jedem `vercel deploy`-Befehl das `--target` explizit im Befehl selbst
  prüfen und im Chat/Log wörtlich nennen, bevor er ausgeführt wird.
- Freigaben wie "deploy das als Preview" gelten NUR für einen Befehl mit
  `--target=preview` im exakten Wortlaut. Ein Befehl ohne dieses Flag gilt
  NICHT als abgedeckt, auch wenn der Kontext "Preview" war.

## Parallele-Sessions-Sperre

Vor jeder schreibenden Aktion (Commit, Push, Deploy, Datei-Änderung mit
Absicht zu committen) in diesem Repo:

1. Prüfen, ob `.agent-lock.json` im Repo-Root existiert und noch nicht
   abgelaufen ist (`expiresAt` in der Zukunft) mit einer anderen
   `sessionId`.
2. Falls ja: Felix explizit fragen, ob parallel gearbeitet werden darf,
   bevor irgendetwas Schreibendes ausgeführt wird.
3. Falls nein: eigene `.agent-lock.json` anlegen
   (`{ sessionId, tool, startedAt, expiresAt = jetzt + 30 Minuten,
   workingDir }`) und bei Sessionende wieder entfernen.

`.agent-lock.json` ist in `.gitignore` und wird niemals committed.

Für Claude Code übernimmt bereits ein PreToolUse-/SessionEnd-Hook diese
Prüfung automatisch (siehe `.claude\settings.json` sowie
`.claude\hooks\scripts\agent-lock-guard.mjs` und `agent-lock-cleanup.mjs`
im zentralen KI-Workspace `C:\Users\felil\Documents\KI`). Für Tools ohne
eigenes Hook-System (z. B. Codex) gilt die obige Konvention manuell.

## Contract-Test bei Recommendation-Engine-Änderungen

Nach jeder Änderung an der Recommendation-Engine (`orchestrator/recommendation-engine.js`,
`orchestrator/server.js` oder `docs/recommendation-engine-v1.md`): Command-Center-
Contract-Test manuell laufen lassen und Ergebnis im Chat mitteilen, bevor der
Commit als abgeschlossen gilt:

```
node --test test/recommendation-contract.test.js
```

(im Repo `felix-command-center` ausführen). Ein lokaler `post-commit`-Hook
(siehe `scripts/git-hooks/post-commit`, Installation in `README.md`) erinnert
zusätzlich automatisch daran.
