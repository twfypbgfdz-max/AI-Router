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

Zusätzlich blockieren lokale `pre-commit`/`pre-push`-Git-Hooks (Vorlage in
`scripts/git-hooks/pre-commit`/`pre-push`, Installation in `README.md`)
Commits/Pushes bei einem gültigen fremden Lock hart (Exit-Code ≠ 0, keine
Rückfrage) — das gilt für ALLE Aufrufer (Claude Code, Codex, manuelle
Git-Befehle), nicht nur für Claude Code. Bekannte Einschränkung: die
verlässliche automatische Selbsterkennung (über einen Session-Marker,
den der PreToolUse-Hook hinterlegt) funktioniert bisher nur für Claude
Code. Andere Tools müssen sich optional selbst über die Umgebungsvariable
`AGENT_LOCK_SESSION_ID` identifizieren, sonst blockiert der Git-Hook sie
auch bei ihrem eigenen aktiven Lock.

## Hinweis: Verwaistes Lock nach Absturz

Wenn eine Session hart abstürzt (Terminal-Kill, Systemabsturz), greift
der SessionEnd-Cleanup-Hook nicht mehr. Das Lock bleibt dann bis zu
30 Minuten bestehen, auch wenn die haltende Session nicht mehr existiert.
In dieser Zeit blockieren die Git-Hooks (pre-commit/pre-push) neue
Commits/Pushes von anderen Sessions in diesem Repo — das ist erwartetes
"fail closed"-Verhalten, kein Fehler.

Falls das auftritt und sicher ist, dass keine andere Session mehr aktiv
läuft: `.agent-lock.json` im Repo-Root manuell löschen. Danach funktionieren
Commits wieder normal.

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
