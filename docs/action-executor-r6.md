# First Safe Executor (R6)

Stand: 21.08.2026. Beschreibt ausschließlich den tatsächlich implementierten
Stand in `orchestrator/action/`. Baut auf [Action Foundation (R4)](action-foundation-r4.md)
und [Action Resolution + Approval Resume (R5)](action-resolution-approval-r5.md)
auf und ändert dort weder Lifecycle noch Policy noch Approval-Modell.

## Zweck und Abgrenzung

Erste echte, aber extrem eng begrenzte Ausführung durch die volle Jarvis-
Kette (Intent Router → Action Resolver → Action Service → Approval →
Pending/Resume → Executor → Audit + Result). Genau eine Action ist ab R6
wirklich ausführbar: `app.open`, und dort nur für zwei fest im Code
registrierte Ziele.

Nicht Teil von R6: `app.close`/`app.kill`, `system.*`, `file.*`,
`browser.*`, `email.*`, `calendar.*`, Remote-Agent-Funktionen, eine
generische Shell-/Kommandoschnittstelle.

## Modul

| Datei | Rolle |
|---|---|
| `app-launcher.js` (neu) | Die einzige Stelle, die `child_process.spawn()` aufruft. Feste Allowlist `{ spotify, obsidian }` mit je einem fixen, aus `LOCALAPPDATA` abgeleiteten Pfad und einer leeren, festen Argumentliste. `shell: false` immer. |
| `action-registry.js` (geändert) | `app.open` hat jetzt einen echten Executor: `(parameters) => appLauncher.launch(parameters.target)`. `target`-Enum um `"obsidian"` erweitert. |
| `action-resolver.js` (geändert) | Parameter-Alias `target.obsidian → ["obsidian"]` ergänzt. |
| `action-service.js` (minimal geändert) | Der Executor-`catch`-Block reicht jetzt einen strukturierten `error.code` durch, wenn er in `ACTION_ERROR_CODES` registriert ist, statt jeden Executor-Fehler auf `ACTION_EXECUTION_FAILED` zu maskieren. Die Fehlertext-Maskierung selbst bleibt unverändert. |

## Sicherheitsgrenzen (unverändert gegenüber Auftrag)

* **Keine generische Shell-Schnittstelle.** Kein `exec()`, kein
  `Start-Process <string>`, kein zusammengesetzter Kommandozeilen-String.
  `app-launcher.js` ruft ausschließlich `spawn(fixedExePath, fixedArgs,
  { shell: false })` auf.
* **Harte Allowlist im Code**, nicht in einer nutzereditierbaren Config.
  Ein `target`, das nicht in `APP_LAUNCH_DEFINITIONS` steht, erreicht
  `spawn()` nie — auch nicht, wenn die Registry aus irgendeinem Grund einen
  anderen Wert durchließe (`app-launcher.js` prüft seine eigene Allowlist
  erneut, statt der Registry blind zu vertrauen).
* **Keine Pfade/Kommandos aus dem User-Prompt.** Der Resolver liefert nur
  einen von zwei geschlossenen Enum-Werten (`"spotify"` / `"obsidian"`);
  Freitext erreicht den Executor nie.
* **Installationserkennung** ausschließlich über einen festen, bekannten
  Pfad je App (kein rekursives Suchen, kein Raten). Fehlt die Datei an
  diesem Pfad: `APP_NOT_INSTALLED`, kein Fallback-Suchen.
* **Boundary-Frage geprüft (Spec-Punkt 21):** ein separater lokaler Dienst
  wäre für R6 Overkill gewesen — der Executor ist reiner, synchroner,
  lokaler Code ohne Netzwerkoberfläche, exakt wie `jarvis-speak-service.js`s
  bestehender `spawn()`-Aufruf für `piper.exe`. Die Architektur bleibt
  `AI-Router → structured Action → trusted local executor boundary`
  (`app-launcher.js` ist diese Boundary), nicht `AI-Router → OS command`.
  Eine Auslagerung in einen eigenen Prozess bleibt eine spätere,
  eigenständige Entscheidung, sobald ein echter Remote Agent ansteht.

## Unterstützte Apps und Launch-Methode

| App | Pfad (fix, aus `LOCALAPPDATA` abgeleitet) | Methode |
|---|---|---|
| `spotify` | `%LOCALAPPDATA%\Microsoft\WindowsApps\Spotify.exe` | App-Execution-Alias (Microsoft-Store-Paket); Windows löst den Reparse-Point selbst auf. |
| `obsidian` | `%LOCALAPPDATA%\Programs\Obsidian\Obsidian.exe` | Direkter Pfad einer regulären Pro-User-Installation. |

Beide Pfade wurden am 21.08.2026 auf diesem PC real verifiziert (vorhanden).
Bereits laufende Instanz: keine eigene Fenster-Automation in R6 — ein
erneuter Start ist idempotent im Sinne von "kein Fehler"; was genau
passiert (Fokus vs. zweite Instanz), entscheidet die jeweilige App/Windows
selbst.

## Ergebnis- und Fehlerformat

Erfolg:

```js
{ ok: true, app: "spotify" | "obsidian", state: "opened" }
```

Neue Fehlercodes (`ACTION_ERROR_CODES` in `action-types.js`, gespiegelt in
`orchestrator/policy.js`s zentraler `ERROR_CODES`-Liste):

| Code | Bedeutung |
|---|---|
| `APP_NOT_ALLOWED` | `target` ist kein Eintrag der Allowlist (kann durch die Registry-Enum-Validierung praktisch nie von außen ausgelöst werden — zweite, unabhängige Verteidigungsschicht). |
| `APP_NOT_INSTALLED` | Der feste Pfad existiert auf diesem Rechner nicht. |
| `APP_LAUNCH_FAILED` | `spawn()` selbst ist fehlgeschlagen (OS-Fehler beim Prozessstart). |

## Approval bleibt Pflicht

`app.open` ist weiterhin `risk: "medium"`, `requiresApproval: true`. Es gibt
keine Sonderbehandlung, keine automatische Freigabe, keinen Low-Risk-
Override — dieselbe Kette wie in R4/R5:

```
"Öffne Spotify" → resolved (app.open/spotify) → approval_required
→ POST /api/actions/:id/approval { decision: "approve" } → executing
→ app-launcher.js.launch("spotify") → completed
```

## Tests

`test/app-launcher.test.js` (10 Tests, neu): Allowlist (erlaubt/unbekannt/
Injection-Versuche), Installationserkennung, `shell:false` + feste leere
Argumentliste, Fehlernormalisierung bei echtem Spawn-Fehler, `unref()` bei
Erfolg. Jeder Test injiziert `spawnImpl`/`existsImpl` — kein Test in dieser
Datei startet einen echten Prozess.

`test/app-open-r6-integration.test.js` (4 Tests, neu): Resolver → echte
Default-Registry → `actionService` → `actionApprovalService`, mit
`appLauncher.launch` als einzigem ersetzten Blatt-Aufruf. Deckt: Auflösung
+ Freigabepflicht, Ablehnung führt nie zur Ausführung, echter Launch-Fehler
führt nie zu einem vorgetäuschten Erfolg, ein nicht registriertes Ziel
(„Öffne Notepad.") bleibt `unresolved`.

`test/action-approval-api.test.js` (geändert): der frühere Test "approve
führt zu `ACTION_EXECUTOR_UNAVAILABLE`" ist durch zwei Tests ersetzt —
erfolgreicher Ende-zu-Ende-Lauf über HTTP (mit ersetztem `appLauncher.launch`,
sonst reale Kette) und normalisierter `APP_NOT_INSTALLED`-Fehlerfall. Beide
nutzen denselben, nicht cache-gebusteten Singleton-Import von
`app-launcher.js`, den auch das frisch importierte `server.js` transitiv
verwendet — kein echter Prozess wird durch die automatisierte Suite
gestartet.

`test/action-resolution.test.js` / `test/action-foundation.test.js`: um
Obsidian-Auflösung bzw. die drei neuen Fehlercodes ergänzt.

Regression: volle Suite vor und nach R6 grün (1352/1352 vorher,
1370/1370 nachher, 0 Fails, 2 unveränderte Skips), siehe Abschlussbericht.

## Realer Smoke-Test (21.08.2026)

Über einen frisch gestarteten, isolierten Server-Prozess (eigener
`DATA_DIR`, ephemerer Port) und die echte HTTP-Kette — kein
Direktaufruf des Executors:

```
POST /api/jarvis/ask {"question":"Öffne Spotify."}
  -> actionStatus: approval_required, approvalRequired: true
GET  /api/actions/:id
  -> pending.status: approval_required, actionId: app.open, target: spotify
POST /api/actions/:id/approval {"decision":"approve","decidedBy":"felix-smoke-test"}
  -> status: completed, executed: true
     result: { ok: true, app: "spotify", state: "opened" }
```

Spotify lief vor dem Test nicht (`tasklist` leer) und lief danach real
(7 `Spotify.exe`-Prozesse, Electron-typisch mehrere Subprozesse). Kein
Shell-Bypass, keine zweite/direkte Ausführung außerhalb dieser einen Kette.

## Offen für R7

* `app.close` / Fenster-Fokussierung einer bereits laufenden Instanz.
* Weitere Allowlist-Einträge (nur nach derselben Verifikation wie hier).
* ~~Authentifizierte Approval-Quelle~~ — erledigt in
  [Approval Source Hardening + Action Rate Limit (R7)](approval-source-hardening-r7.md):
  `POST /api/actions/:id/approval` verlangt jetzt einen gültigen
  `AI_ROUTER_APPROVAL_TOKEN`, plus ein Rate-Limit für echte Ausführung.
* Aufräumen abgelaufener/terminaler Pending-Dateien (weiterhin unverändert
  offen, jetzt für R8).
