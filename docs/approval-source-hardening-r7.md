# Approval Source Hardening + Action Rate Limit (R7)

Stand: 22.08.2026. Beschreibt ausschließlich den tatsächlich implementierten
Stand. Baut auf [Action Foundation (R4)](action-foundation-r4.md),
[Action Resolution + Approval Resume (R5)](action-resolution-approval-r5.md)
und [First Safe Executor (R6)](action-executor-r6.md) auf und ändert dort
weder Lifecycle, Registry, Replay-Schutz noch die Allowlist.

## Zweck und Abgrenzung

Vor R7 war `POST /api/actions/:id/approval` nur durch `isTrustedMutation()`
geschützt (derselbe schwache "same-origin-oder-kein-Origin"-Check wie jede
andere Mutation in `server.js`) — **jeder lokale Aufrufer konnte jede
wartende Action freigeben**, unabhängig vom `decidedBy`-Feld im Body, das
reiner Freitext war. R5/R6 dokumentierten das explizit als offenen Punkt
("Authentifizierte Approval-Quelle, weiterhin nur lokale Same-Origin-Grenze").

R7 schließt genau diese Lücke plus ein Rate-Limit für echte Ausführung.
**Keine neuen Executors, keine Änderung an Registry/Allowlist/Replay-Schutz.**

## 1. Approval Source Hardening

`server.js`s Handler für `POST /api/actions/:id/approval` prüft jetzt, in
dieser Reihenfolge, bevor `actionApprovalService.decide()` überhaupt
aufgerufen wird:

1. `isTrustedMutation()` (unverändert, bleibt als zusätzliche Schicht).
2. **`authenticateInternalRequest()`** (bereits bestehender Mechanismus aus
   `orchestrator/internal-auth.js`, bisher genutzt für die Command-Center-
   Endpunkte `/api/v1/cc/*`) — verlangt einen gültigen Bearer-Token gegen
   das neue `AI_ROUTER_APPROVAL_TOKEN` (mindestens 32 Zeichen, `.env.example`).
   Timing-sicherer Vergleich (SHA-256-Digest + `crypto.timingSafeEqual`),
   identisch zum bestehenden CC-Mechanismus. **Kein neues Auth-System** —
   nur eine weitere, eigene Token-Variable für diese Oberfläche, nach
   derselben Konvention wie `AI_ROUTER_CC_TOKEN`.

`source` und `actor` werden **niemals aus dem Request-Body gelesen**. Sobald
die Authentifizierung erfolgreich ist, setzt der Server sie serverseitig fest
(`source: "jarvis-ui"`, `actor: "local-user"`) und schreibt sie so ins
Audit-Log (`action_approval_received`). Ein Client, der `{"source": "...",
"actor": "..."}` im Body mitschickt, hat keinerlei Einfluss — ohne gültigen
Token wird trotzdem mit `401`/`403` abgelehnt (siehe
`test/action-approval-auth.test.js`, "a client cannot spoof its trust level").
`decidedBy` bleibt wie in R5 ein optionales, sanitisiertes Freitextfeld für
die Audit-Notiz im Pending-Record — es ist nach R7 explizit **kein**
Sicherheitsmerkmal mehr, sondern nur ein menschenlesbares Label, weil die
eigentliche Vertrauensentscheidung jetzt am Token hängt.

### Fehlerverhalten (default deny)

| Zustand | HTTP | Fehlercode |
|---|---|---|
| Kein `Authorization`-Header | 401 | `APPROVAL_AUTH_REQUIRED` |
| Falscher Token | 403 | `APPROVAL_SOURCE_UNTRUSTED` |
| Kein Token serverseitig konfiguriert (`AI_ROUTER_APPROVAL_TOKEN` fehlt/zu kurz) | 403 | `APPROVAL_SOURCE_UNTRUSTED` |

Die letzten beiden Fälle liefern absichtlich denselben Code — ein Aufrufer
darf nie unterscheiden können, ob der Server falsch konfiguriert ist oder ob
er selbst den falschen Token gesendet hat (Informationsleck vermeiden).
`reject` unterliegt derselben Grenze wie `approve` — es gibt keinen
authentifizierungsfreien Ablehnungspfad.

## 2. Action Rate Limit

Wiederverwendet: `orchestrator/rate-limiter.js` (`createRateLimiter()`),
bereits produktiv genutzt in `cc-reindex-handler.js` und
`text-response-handler.js`. **Keine neue Rate-Limit-Implementierung.**

* Konstanten (`config.js`): `ACTION_APPROVAL_MAX_EXECUTIONS_PER_WINDOW = 5`,
  `ACTION_APPROVAL_RATE_WINDOW_MS = 60_000` — 5 echte Ausführungen pro
  Minute, konservativ für normale lokale Einzelnutzung, aber kein Show-
  Stopper für z. B. mehrere unterschiedliche Actions kurz hintereinander.
* **Modell:** pro Actor (dem verifizierten `identityFingerprint` aus dem
  Approval-Token — nicht aus dem Body) und ausschließlich für
  `decision: "approve"`. `reject` verbraucht kein Budget, weil dabei nichts
  ausgeführt wird.
* **Nur echte, frische Ausführungsversuche verbrauchen Budget:** Bevor der
  Limiter konsultiert wird, prüft der Handler per
  `actionApprovalService.get(requestId)` (rein lesend, unverändert aus R5),
  ob der Pending-Record aktuell wirklich noch `approval_required` ist. Ist
  die Anfrage unbekannt, bereits entschieden oder abgelaufen, wird der
  Limiter gar nicht erst angefasst — Replay-Spam gegen dieselbe ID bleibt
  `409`/`404`/`410` wie in R5, wird nie zu `429` und verbraucht kein Budget.
  Ein fehlgeschlagener Auth-Check (siehe oben) erreicht den Limiter ebenso
  wenig.
* **Reihenfolge fest:** Approval-Auth → Rate Limit → `decide()` (Executor).
  Ein blockierter Request ruft `actionService.submit()`/den Executor nie
  auf — siehe `test/action-rate-limit.test.js`, "never reaches the
  executor".
* Bei Überschreitung: `429`, `error.code = "ACTION_RATE_LIMITED"`,
  zusätzlich `retryAfterMs` im Body und ein `Retry-After`-Header
  (Sekunden). Keine vorgetäuschte Erfolgsmeldung.
* Uhr injizierbar: der Limiter wird mit `createRouterServer()`s bereits
  bestehendem `now`-Parameter gebaut (dem Parameter, der zuvor schon für
  Router-Timeouts genutzt wurde) — kein `sleep()` in Tests nötig.
* **Keine neue Persistenz.** In-Memory pro Serverprozess, exakt wie die
  bereits bestehenden CC-/Text-Response-Limiter. Ein Prozessneustart setzt
  das Limit zurück — für ein lokales Single-Operator-Tool ausreichend; R5s
  Replay-Schutz (dateibasiert, überlebt Neustarts) bleibt die eigentliche
  Sicherheitsgarantie gegen doppelte Ausführung, das Rate-Limit ist eine
  zusätzliche, bewusst einfache Schicht dagegen.

## Fehlercodes (neu, R7)

Registriert in `orchestrator/policy.js` (`ERROR_CODES`) und gespiegelt in
`orchestrator/action/action-types.js` (`ACTION_ERROR_CODES`), derselben
Konvention wie R4–R6:

| Code | Bedeutung |
|---|---|
| `APPROVAL_AUTH_REQUIRED` | Kein `Authorization`-Header auf dem Approval-Endpoint. |
| `APPROVAL_SOURCE_UNTRUSTED` | Token falsch oder serverseitig nicht konfiguriert. |
| `ACTION_RATE_LIMITED` | Zu viele echte Approve-Ausführungen im Zeitfenster. |

## Audit (neu, R7)

Über `safeLog()` in `server.js` (dieselbe JSONL-Audit-Senke wie jedes
andere Event, `.ai-router-data/router-events.jsonl`):

| Event | Wann |
|---|---|
| `action_approval_received` | Trust-Boundary bestanden, bevor `decide()` läuft. Enthält die serverseitig fixen `source`/`actor`. |
| `action_approval_rejected_auth` | Auth fehlgeschlagen (fehlend, falsch, nicht konfiguriert) — `reason` = interner `AUTH_*`-Code. |
| `action_approval_accepted` | Auth + (falls `approve`) Rate-Limit-Check bestanden, unmittelbar vor `decide()`. |
| `action_rate_limited` | Rate-Limit hat einen `approve`-Versuch blockiert, mit `retryAfterMs`. |

Keine Secrets, keine Tokens, keine Body-Freitexte außer dem bereits
sanitisierten `decidedBy`-Pfad (unverändert aus R5) werden geloggt.

## Sicherheitsregression geprüft

* Keine Shell, keine freie Action-ID, keine freien App-Pfade — unverändert
  (R6s `app-launcher.js`/`action-registry.js` nicht angefasst).
* Approval bleibt Pflicht — `app.open` weiterhin `requiresApproval: true`.
* R5-Replay-Schutz (`action-pending-store.js`) unverändert, keine Zeile
  angefasst.
* R6-Allowlist (`spotify`, `obsidian`) unverändert.
* Bestehende HTTP-Contracts (`/api/runs/:id/approval` u. a.) unverändert —
  R7 betrifft ausschließlich `/api/actions/:id/approval`.

## Tests

* `test/action-approval-auth.test.js` (neu, 7 Tests): kein Token → 401;
  falscher Token → 403; nicht konfigurierter Token → 403 (identischer Code
  wie falscher Token); gültiger Token → 200 + echte Ausführung; Reject
  verlangt dieselbe Grenze; Body-`source`/`actor` ohne gültigen Token
  bleibt wirkungslos; unbekannte ID bleibt `404` auch mit gültigem Token.
* `test/action-rate-limit.test.js` (neu, 7 Tests): bis zum Limit erlaubt;
  der überzählige Versuch wird `429` und erreicht den Executor nie;
  nach Fensterablauf wieder erlaubt; Replay einer bereits entschiedenen ID
  verbraucht kein Budget und wird nie `429`; Reject verbraucht kein Budget;
  fehlgeschlagene Auth verbraucht kein Budget; ein frei erfundener
  `actor`/`source` im Body umgeht das Limit nicht.
* `test/action-approval-api.test.js` (geändert): alle Approval-Requests
  tragen jetzt einen gültigen Test-Token; unverändert sonst in Verhalten
  und Assertions.
* Regression: volle Suite vor und nach R7 grün — 1384 Tests, 1382 bestanden,
  2 unveränderte Skips (identisch zum R6-Stand), 0 Fails.

## Realer Smoke-Test (22.08.2026)

Über einen frisch gestarteten, isolierten Server-Prozess (eigener
`DATA_DIR`, ephemerer Port, echter `AI_ROUTER_APPROVAL_TOKEN`) und die echte
HTTP-Kette:

```
POST /api/jarvis/ask {"question":"Öffne Spotify."}
  -> actionStatus: approval_required, approvalRequired: true

POST /api/actions/:id/approval {"decision":"approve","decidedBy":"felix-smoke-test"}
  OHNE Authorization-Header
  -> 401 APPROVAL_AUTH_REQUIRED (kein Executor-Aufruf)

POST /api/actions/:id/approval {"decision":"approve","decidedBy":"felix-smoke-test"}
  MIT Authorization: Bearer <AI_ROUTER_APPROVAL_TOKEN>
  -> status: completed, executed: true
     result: { ok: true, app: "spotify", state: "opened" }
```

Spotify lief danach real (`tasklist` zeigt `Spotify.exe`-Prozesse). Kein
direkter Executor-Aufruf als Ersatz, kein Shell-Bypass.

## Offen für R8

* `/api/runs/:id/approval` (das ältere, laufbezogene Approval-Gate) teilt
  sich denselben schwachen `isTrustedMutation()`-Check und wurde in R7
  bewusst **nicht** mit angefasst — R7s Auftrag war ausschließlich
  `/api/actions/:id/approval`. Eine spätere Entscheidung, ob dieselbe
  Härtung dort ebenfalls sinnvoll ist, steht noch aus.
* Aufräumen abgelaufener/terminaler Pending-Dateien (weiterhin unverändert
  offen aus R5/R6).
* `app.close` / Fenster-Fokussierung, weitere Allowlist-Einträge (weiterhin
  offen aus R6).
* Eine echte Multi-Actor-Unterscheidung (aktuell: ein gemeinsamer Token =
  ein Actor) wäre erst relevant, sobald mehrere unterschiedliche
  Approval-Quellen existieren — aktuell nicht der Fall.
