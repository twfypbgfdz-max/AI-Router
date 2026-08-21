# Action Resolution + Approval Resume (R5)

Stand: 21.08.2026. Beschreibt ausschließlich den tatsächlich implementierten
Stand in `orchestrator/action/`. Baut auf [Action Foundation (R4)](action-foundation-r4.md)
auf und ändert dort nichts an der bestehenden Executor-Grenze, dem
Approval-Modell oder dem Lifecycle.

## Zweck und Abgrenzung

R4 endete für jede Handlungsanfrage bewusst unaufgelöst: `actionId: null`,
abgelehnt durch die Default-deny-Regel der Registry. R5 schließt zwei der
drei in R4 offen gelassenen Lücken:

1. **Auflösung** eines Action-Intents auf eine konkrete, registrierte
   Action (`orchestrator/action/action-resolver.js`).
2. **Wiederaufnahme** eines Requests im Status `approval_required` über
   einen späteren, unabhängigen HTTP-Aufruf hinweg
   (`orchestrator/action/action-pending-store.js`,
   `orchestrator/action/action-approval-service.js`).

Nicht Teil von R5 (bewusst, siehe unten "Nicht Teil von R5"): echte
Executoren, ein Remote Agent, eine authentifizierte Approval-UI, Modell-
gestützte Slot-Filling.

## Module

| Datei | Rolle |
|---|---|
| `action-resolver.js` | Deterministische, Registry-verankerte Auflösung einer Frage auf `{ resolution, actionId, params }`. |
| `action-intent-bridge.js` | Erweitert um den Resolver-Aufruf; unverändert im Vertrag "kein freier Modellaufruf". |
| `action-pending-store.js` | Datei-basierte Persistenz eines Requests im Status `approval_required`, mit TTL und Replay-Schutz. |
| `action-approval-service.js` | `decide(requestId, { decision, decidedBy, note })` — die einzige Stelle, die einen persistierten Request wieder in `action-service.js` einspeist. |

## Resolver

`resolveActionIntent(question, registry)` gibt immer genau eines von vier
Ergebnissen zurück:

```js
{ resolution: "resolved",   actionId, params, confidence: "exact" }
{ resolution: "ambiguous",  candidates: [{ actionId, parameters }] }
{ resolution: "unresolved" }
{ resolution: "invalid" }   // keine nutzbare Frage oder keine gültige Registry
```

Arbeitsweise, zweistufig:

1. Eine kleine, handgepflegte Alias-Tabelle (Verb → Action-ID, Freitext →
   Enum-Wert) *schlägt* einen Kandidaten nur vor.
2. Die Registry selbst (`registry.has()`, `registry.resolve()`,
   `validateActionParameters()`) entscheidet abschließend. Ein Kandidat, den
   die Registry nicht kennt oder dessen Parameter nicht durchgehen, wird
   verworfen — nie zurückgegeben.

Damit gilt für jede Übergabe-Registry (Produktions-Registry oder ein
Test-Fixture): der Resolver kann niemals eine Action zurückgeben, die diese
konkrete Registry nicht auch selbst als gültig bestätigt. Es gibt keinen
Modellaufruf und kein freies Slot-Filling; würde später ein Modell
vorgeschaltet, müsste dessen Ausgabe genau wie jeder andere Kandidat durch
Schritt 2 laufen.

Ausgelieferte Aliase (R5, an R4s zwei registrierten Actions):

| Action | Verb-Aliase | Parameter-Aliase |
|---|---|---|
| `app.open` | öffne, öffnen, starte, starten, start | `target`: spotify → "spotify" |
| `jarvis.action.list` | liste die aktionen, zeig(e) die aktionen, welche aktionen, verfügbare aktionen | keine (parameterlos) |

Ambiguität entsteht nur, wenn mehr als eine unterschiedliche Action mit
gültigen Parametern zugleich passt (z. B. "Öffne Spotify, und welche
Aktionen gibt es sonst noch?"). Ein erkanntes Verb ohne erkennbares Ziel
("Öffne das.", "Öffne Notepad.") bleibt `unresolved`, nie geraten.

## Integration mit R2/R4

`action-intent-bridge.js`s `buildActionRequestFromIntent()` ruft den
Resolver jetzt mit der Frage und — wichtig — mit **derselben Registry-
Instanz, die der aufrufende `actionService` tatsächlich verwendet**
(`actionService.registry`), nicht mit einem modulweiten Default. Das
verhindert ein stilles Auseinanderlaufen zwischen "was der Resolver für
gültig hält" und "was der Service tatsächlich ausführt" — insbesondere in
Tests, die einen eigenen Fixture-`actionService` injizieren.

`jarvis-console-proxy.js` (`/api/jarvis/ask`) meldet zusätzlich:

```js
{
  ...,
  executionAvailable: boolean,   // == actionService-Result.executed, nie geraten
  actionRequestId, actionStatus, actionErrorCode,
  approvalRequired: boolean
}
```

Die Antwort-Freitextzeile unterscheidet jetzt drei ehrliche Fälle (nie eine
falsche Erfolgsmeldung, aber auch nie eine falsche "nicht ausgeführt"-Aussage
für eine tatsächlich gelaufene Action wie `jarvis.action.list`):

- tatsächlich ausgeführt (`executed === true`)
- `approval_required` (Freigabe nötig, Request gespeichert)
- alles andere (abgelehnt/nicht registriert/fehlgeschlagen — wie in R4)

## Pending Store

Ein Request, der bei `actionService.submit()` mit Status `approval_required`
endet, wird von `jarvis-console-proxy.js` genau einmal persistiert:

```js
{
  requestId, actionId, parameters,   // bereits Registry-validierte Enum-Werte
  origin, risk,
  status: "approval_required" | "approved" | "rejected" | "expired" | "completed" | "failed",
  createdAt, expiresAt,
  decidedBy: null | string, decidedAt: null | string, note
}
```

Gespeichert wird unter `DATA_DIR/actions/pending/<requestId>.json`, mit
demselben Atomic-Write-Muster (Temp-Datei + Rename) wie
`orchestrator/run-store.js`. Es wird **keine Nutzerfrage und kein Freitext**
gespeichert — nur bereits Registry-validierte Werte.

**TTL:** `ACTION_PENDING_TTL_MS = 15 Minuten` (`orchestrator/config.js`).
Ablauf wird lazy geprüft (kein Hintergrund-Timer) — beim nächsten Lese- oder
Entscheidungsversuch wird ein abgelaufener Request auf `expired` gesetzt und
bleibt es dauerhaft.

**Nebenläufigkeit:** Das System ist Single-Node (wie `session-store.js` und
`run-service.js`s bestehende In-Memory-Freigabe). Die "genau einmal"-Garantie
einer Entscheidung wird über eine In-Memory-Promise-Kette pro `requestId`
sichergestellt (dasselbe Muster wie `session-store.js`s `writeLocks`),
während der Datensatz selbst auf Platte liegt und damit einen
Prozess-Neustart übersteht.

## Approval-Resume-Flow

`action-approval-service.js`s `decide(requestId, { decision, decidedBy, note })`
ist die einzige Stelle, die approve/reject/resume zusammenfasst:

1. `pendingStore.claimForDecision()` — default deny: unbekannte ID, bereits
   entschiedene ID oder abgelaufene ID werden **vor** jedem Kontakt mit
   `action-service.js` abgelehnt (`ACTION_PENDING_NOT_FOUND`,
   `ACTION_PENDING_ALREADY_DECIDED`, `ACTION_PENDING_EXPIRED`).
2. Der ursprüngliche, bereits Registry-validierte `actionId`/`parameters`
   werden erneut an `actionService.submit()` gegeben — nie etwas aus dem
   HTTP-Body außer der Entscheidung selbst. Eine manipulierte Kopie der
   persistierten Datei wird dadurch bei der Wiederaufnahme erneut gegen die
   Registry geprüft, nicht blind vertraut.
3. Bei `approve` markiert `finalizeResume()` den Datensatz mit dem
   tatsächlichen `action-service`-Ergebnis (`completed` oder `failed`) —
   niemals wieder ausführbar. Bei `reject` ist der Datensatz bereits durch
   Schritt 1 terminal (`rejected`).

Es gibt bewusst **keinen separaten `resume()`-Aufruf**: Ein `approval_required`-
Request kann nur über eine Entscheidung in den Status `approved` gelangen,
und `decide("approve", …)` löst Wiederaufnahme und Ausführung in einem
Aufruf aus — das ist bereits die kleinste korrekte Form.

## HTTP-Oberfläche

```
GET  /api/actions/:requestId            -> { pending } | 404 ACTION_PENDING_NOT_FOUND
POST /api/actions/:requestId/approval   -> action-service.js publicView() | 404/409/410
     Body: { decision: "approve" | "reject", decidedBy, note? }
```

Gleiches Vertrauensmodell wie jede andere mutierende Route in diesem Repo
(`isTrustedMutation()` — lokaler Origin + JSON-Content-Type). Es gibt **keine
Approval-UI** und keine Authentifizierung über diese lokale Same-Origin-
Prüfung hinaus — siehe "Nicht Teil von R5".

| HTTP-Status | Fehlercode |
|---|---|
| 404 | `ACTION_PENDING_NOT_FOUND` |
| 409 | `ACTION_PENDING_ALREADY_DECIDED` |
| 410 | `ACTION_PENDING_EXPIRED` |

## Audit

Zusätzlich zu R4s acht `action_request_*`-Lifecycle-Events (unverändert):

| Event | Bedeutung |
|---|---|
| `action_resolution_resolved` | Resolver hat eindeutig aufgelöst (safeMetadata: `actionId`) |
| `action_resolution_ambiguous` | Resolver hat mehrere Kandidaten gefunden |
| `action_resolution_unresolved` | Resolver hat nichts gefunden |
| `action_pending_stored` | Request wurde persistiert |
| `action_pending_resumed` | Entscheidung hat zu einer Wiederaufnahme geführt (safeMetadata: `outcome`) |
| `action_pending_expired` | Entscheidungsversuch auf einen abgelaufenen Request |
| `action_pending_replay_blocked` | Entscheidungsversuch auf einen bereits entschiedenen Request |

Nie protokolliert: die Nutzerfrage, Rohkandidaten des Resolvers, Freitext.

## Nicht Teil von R5

* Kein echter Windows-/Remote-Executor. `app.open` bleibt nach Freigabe bei
  `ACTION_EXECUTOR_UNAVAILABLE` — Auflösung und Freigabe funktionieren jetzt
  vollständig, Ausführung weiterhin nicht.
* Keine authentifizierte Approval-UI. `decidedBy` ist ein vom Aufrufer
  mitgegebenes Feld, keine echte Authentifizierung — dieselbe lokale
  Same-Origin-Vertrauensgrenze wie bei `/api/runs/:id/approval` in
  `run-service.js`.
* Kein Modellaufruf im Resolver, kein freies Slot-Filling.
* Keine Workflow-Engine, kein Semantic Memory, keine echten Datei-/Mail-/
  Kalender-Actions.

## Tests

`test/action-resolution.test.js` (13 Tests): eindeutige Auflösung, Alias,
unbekanntes Ziel, mehrdeutige Anfrage, ungültige/leere Frage, Registry als
alleinige Autorität (auch bei manipulierter Alias-Erwartung), R2→R5-Naht.

`test/action-approval-resume.test.js` (9 Tests): Persistenz bei
`approval_required`, Freigabe führt zu genau einer Ausführung, Ablehnung ist
terminal, unbekannte ID, TTL/Expiry, gleichzeitige Freigabe/Ablehnung,
manipulierte Body-Felder werden ignoriert, manipulierte Datei-Parameter
werden bei Wiederaufnahme erneut validiert.

`test/action-approval-api.test.js` (5 Tests): HTTP-Oberfläche Ende-zu-Ende
über einen echten, isolierten `DATA_DIR`.

Regression: volle Suite vor und nach R5 grün (siehe Abschlussbericht).

## Offen für R6

* Echte Executoren (Remote Agent / Windows Executor) als eigenes,
  abgesichertes Modul.
* Authentifizierte Approval-Quelle (Jarvis-UI/Command-Center/Cockpit statt
  reiner Same-Origin-Vertrauensgrenze).
* Aufräumen abgelaufener/terminaler Pending-Dateien (aktuell bleiben sie
  liegen, keine automatische Bereinigung).
