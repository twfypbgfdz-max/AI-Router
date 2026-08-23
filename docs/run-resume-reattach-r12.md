# Run Resume/Reattach nach Reload (R12)

Stand: 23.08.2026. Schließt Fund 2 aus
[Operational Approval Flow E2E + Panel-Fix (R11)](../test/run-approval-bff.test.js):
`activeRunId` in `01_APP/tests/ai-router-v0_13-test.html` war eine reine
In-Page-Variable ohne Persistenz. Ein Reload während `awaiting_approval`
oder `running` ließ die UI den Bezug zum laufenden Run vollständig
verlieren, obwohl der Server (`RunService.activeRunId` plus der bei jedem
Statuswechsel persistierte Latest-Run) den Run korrekt weiterführte.

## Gewählte Strategie

Kleinste tragfähige Änderung, keine neue Architektur:

* Kein neuer Endpoint, kein `localStorage`, keine Client-Persistenz
  irgendeiner Art.
* `GET /api/runs/latest` war bereits Server-Source-of-Truth für „welcher
  Run wurde zuletzt angefasst" (`server.js`, bei jedem `update()` in
  `run-service.js` neu geschrieben) und liefert die `runId`.
* Reattach nutzt exakt denselben `poll()`/`decide()`-Pfad, den auch ein
  frisch gestarteter Run durchläuft. `GET /api/runs/:id` liest weiterhin
  aus dem In-Memory-Service und liefert damit den vollständigen
  Freigabekontext (anders als die auf Platte persistierte, um
  `approvalContext` bereinigte Kopie).
* Einzige Ausschlussregel: Status aus `RunService`s eigenem `TERMINAL`-Set
  (`succeeded`/`failed`/`cancelled`/`timed_out`) wird nie reattached —
  `awaiting_approval` zählt bewusst nicht dazu.

Der Fix ist eine neue Funktion `reattach()` (13 Zeilen) plus ein Aufruf
beim Seitenladen. Keine Änderung an R9-Nonce/BFF, R7/R9-Token oder der
State-Machine.

```js
const RESOLVED_RUN_STATUSES=['succeeded','failed','cancelled','timed_out'];
async function reattach(){
  try{
    const response=await fetch('/api/runs/latest');
    if(!response.ok)return;
    const latest=await response.json();
    if(!latest||!latest.runId||RESOLVED_RUN_STATUSES.includes(latest.status))return;
    activeRunId=latest.runId;
    poll(activeRunId)
  }catch(e){}
}
```

## Tests

Fünf neue Regressionstests in `test/run-reattach-ui.test.js`, die das
reale Inline-`<script>` der Seite per `node:vm`-Sandbox mit Fake-DOM und
geskriptetem `fetch` ausführen (kein `jsdom` im Projekt vorhanden) — vor
dem Fix rot bestätigt (`activeRunId` blieb `null`, Approve nach Reattach
unmöglich, kein Polling), nach dem Fix grün.

## Manuelle Verifikation (real gegen den laufenden `dev`-Prozess, Port 8787)

* **Szenario A** — Run → `awaiting_approval` → Reload → Panel erscheint
  wieder mit vollem Kontext → Approve → `Erfolgreich`. Bestanden.
* **Szenario B** — Run → `awaiting_approval` → Reload → Reject →
  `Abgebrochen`. Bestanden.
* **Szenario C** — laufender Run → Reload mitten in `running` (per
  Netzwerklog belegt: erster Post-Reload-Poll traf den Run noch im
  Schritt „reviewer" an) → Polling lief bis zum Terminalzustand korrekt
  weiter. Bestanden.
* **Szenario D** — bereits abgeschlossener Run → Reload → `GET
  /api/runs/latest` liefert Terminalstatus → kein weiterer `GET
  /api/runs/:id`-Poll, kein Fehl-Reattach. Bestanden.

## Was unverändert bleibt

* Keine Änderung an `orchestrator/server.js`, `run-service.js`,
  `approval-nonce-store.js` oder response-builder.js`.
* Keine neuen Fehlercodes, keine neuen Audit-Events.
* R7–R11 (Token, Nonce, BFF, State Machine, HTTP-Projektion) unverändert.

## Bewusst außerhalb dieses Scopes

* Historische Run-Wiederaufnahme nach einem **Prozessneustart** des
  AI-Router-Servers selbst — R12 deckt ausschließlich den Browser-Reload
  bei weiterhin laufendem Server ab. Ein Neustart des Servers verliert den
  In-Memory-`RunService`-Zustand unverändert.
* Reattach für mehrere gleichzeitig offene Browser-Tabs/-Fenster — das
  bestehende Single-Active-Run-Modell (`RunService` erlaubt nur einen
  aktiven Run) macht das nicht relevant.
