# Run-Approval BFF (R9)

Stand: 23.08.2026 (Threat Model nach Sicherheitsreview präzisiert; siehe
Abschnitt 2a). Schließt einen Teil der in
[Run-Approval-Trust-Boundary-Audit (R8)](run-approval-trust-boundary-r8.md)
dokumentierten Lücke: `POST /api/runs/:id/approval` war ausschließlich durch
`isTrustedMutation()` (kein `Origin`-Header ODER `Origin` ∈
{localhost:8787, 127.0.0.1:8787}) geschützt - jeder lokale Aufrufer konnte
jeden wartenden Run freigeben oder ablehnen. **Was R9 tatsächlich schließt
und was bewusst offen bleibt, steht in Abschnitt 2a (Threat Model) - vor
dieser Präzisierung überzeichnete eine frühere Fassung dieses Dokuments den
Schutzumfang gegenüber lokalen `curl`-/Skript-Aufrufern.**

## 1. Architekturentscheidung

R8 hatte zwei Wege benannt, um die Route wie R7s `/api/actions/:id/approval`
mit `AI_ROUTER_APPROVAL_TOKEN` zu schützen: den Token in die ausgelieferte
HTML/JS einbetten (Secret-Leak) oder eine Backend-/BFF-Schicht vor den
AI-Router setzen. Vor der Umsetzung wurde geprüft, ob `felix-command-center`
oder `felix-cockpit` diese BFF-Rolle bereits erfüllen könnten. Ergebnis:
Nein - beide sind laut R8-Consumer-Audit **keine** Consumer dieser Route und
kennen den Run-Approval-Vorgang gar nicht; der einzige reale Consumer ist die
Seite, die der AI-Router selbst unter `GET /` ausliefert
(`01_APP/tests/ai-router-v0_13-test.html`). Ein Umweg über einen der beiden
Prozesse hätte eine neue Cross-Origin-Fläche (anderer Port, CORS) sowie einen
UI-Umzug bedeutet - größer als nötig und ein Verstoß gegen den expliziten
"kein Architektur-Sprung"-Rahmen dieses Auftrags.

Gewählt wurde die kleinste tragfähige Abweichung: ein neuer, enger
BFF-Endpoint **im selben AI-Router-Prozess** (`POST
/api/runs/:id/approval/ui`), kein neuer Dienst, kein neuer Port, kein CORS.
`AI_ROUTER_APPROVAL_TOKEN` verlässt den Prozessspeicher nie - der BFF-Handler
ruft dieselbe `service.decideApproval()`-Logik wie die gehärtete Route direkt
als In-Process-Funktionsaufruf auf, nie über einen zweiten HTTP-Hop.

## 2. Same-Origin + Nonce: was das mechanisch tut

Same-Origin (`isTrustedMutation()`) bleibt Pflichtprüfung, ist aber laut R8
für sich genommen unzureichend (kein `Origin`-Header besteht die Prüfung
anstandslos). Es existierte im gesamten AI-Router keine Session-/Cookie-
/CSRF-Mechanik, die als zusätzliche Grenze hätte wiederverwendet werden
können (geprüft: kein `Set-Cookie` im Repo; `orchestrator/session/session-store.js`
ist ausschließlich für Jarvis-Gesprächskontext gedacht, die `sessionId` ist
clientseitig frei wählbar und hat keinerlei Auth-Eigenschaft).

Neu eingeführt: `orchestrator/approval-nonce-store.js`, RAM-only, single-use,
kurze TTL (15 Minuten, dieselbe Konvention wie `ACTION_PENDING_TTL_MS`).

* `GET /` (server.js) mintet bei jedem Aufruf einen frischen Nonce
  (`crypto.randomBytes(32)`, hex) und bettet ihn ausschließlich in die
  selbst ausgelieferte HTML ein (`<meta name="approval-nonce" content="…">`)
  - kein Cookie, kein LocalStorage/SessionStorage, keine andere Route liefert
  ihn aus.
* `POST /api/runs/:id/approval/ui` verlangt diesen Nonce im Body. Er wird in
  dem Moment konsumiert (gelöscht), in dem er geprüft wird - unabhängig vom
  Ergebnis. Eine zweite Verwendung desselben Nonce-Werts scheitert (kein
  Replay), und jeder Aufruf ohne (oder mit falschem/abgelaufenem) Nonce
  scheitert mit `401 APPROVAL_NONCE_INVALID`.
* Eine **erfolgreiche** Entscheidung liefert einen frischen Nonce im
  Response-Feld `approvalNonce` zurück, damit dieselbe geöffnete Seite eine
  weitere, spätere Freigabe treffen kann, ohne neu laden zu müssen. Bei
  jedem Fehlerpfad (ungültiger Nonce, Token nicht konfiguriert, unbekannte
  Run-ID) wird **kein** neuer Nonce ausgestellt - sonst ließe sich über den
  Fehlerpfad selbst ein gültiger Nonce erschleifen, ohne je `GET /`
  aufgerufen zu haben.

Wichtig: "verlangt einen zuvor per `GET /` ausgestellten Nonce" ist **nicht
gleichbedeutend mit** "verlangt einen echten Browser". Was das tatsächlich
schützt (und was nicht), steht in Abschnitt 2a.

## 2a. Threat Model - explizit

Ein Sicherheitsreview nach der ersten R9-Umsetzung hat gezeigt, dass eine
frühere Fassung dieses Dokuments den Schutz überzeichnet hat ("Ein
`curl`/Skript ohne vorherigen `GET /` kennt keinen gültigen Nonce" klang nach
Schutz vor jedem Skript - tatsächlich muss ein Angreifer nur genau diesen
`GET /` selbst zuerst ausführen, was jedem lokalen Prozess offensteht). Der
Bypass ist mit `test/run-approval-bff-threat-model.test.js` als **bewusst
akzeptierter, dokumentierter Grenztest** empirisch nachgewiesen und bleibt
im Testsuite als Dauerbeleg für den tatsächlichen Schutzumfang.

**Threat Model A - fremde Web-Origin / CSRF: geschützt.**
Eine bösartige Seite in einem echten Browser-Tab, auf einem fremden Origin
geladen, kann die Antwort von `GET /` wegen der Same-Origin-Policy nicht
lesen und den eingebetteten Nonce daher nicht extrahieren. Ein Cross-Site-
Request-Forgery-Versuch gegen `/api/runs/:id/approval/ui` scheitert an
fehlendem/falschem Nonce.

**Threat Model B - beliebige lokale Prozesse/Skripte desselben
Windows-Users: bewusst NICHT geschützt.**
Jeder Prozess, der unter demselben Windows-Benutzerkonto läuft wie der
AI-Router (`curl`, PowerShell, ein beliebiges lokales Skript, eine andere
lokale Anwendung), kann `GET /` aufrufen, den Nonce per Textsuche aus der
Antwort extrahieren und ihn anschließend gegen `/api/runs/:id/approval/ui`
verwenden - ohne Browser, ohne JavaScript-Ausführung, ohne
`AI_ROUTER_APPROVAL_TOKEN`. Der Nonce bindet an nichts außer "wurde einmal
per `GET /` ausgegeben"; das ist über reines HTTP von jedem lokalen
Aufrufer gleichermaßen erfüllbar, ein Browser hat dabei keinen technischen
Vorteil gegenüber einem Skript.

**Warum das zum bestehenden Felix-Core-Trust-Modell passt:** Der lokale
Windows-User-Account ist bereits an anderer Stelle im System die faktische
Vertrauensgrenze, nicht der einzelne Prozess. `AI_ROUTER_CC_TOKEN`,
`AI_ROUTER_INTERNAL_TOKEN` und (nach R9) `AI_ROUTER_APPROVAL_TOKEN` selbst
liegen als Windows-User-Umgebungsvariablen vor (siehe
`felix-core-pfade`-Notiz im Vault) - für jeden Prozess desselben Users
ohnehin lesbar. Ein Angreifer, der bereits Code als dieser Windows-User
ausführen kann, hat unabhängig von dieser Route bereits Zugriff auf
Umgebungsvariablen, Dateien und damit auf deutlich mehr als eine
Run-Approval. Threat Model B als eigene Grenze *dieser einen Route*
zusätzlich zu schließen, ohne das umfassendere Problem "beliebiger Code als
dieser Windows-User" zu lösen, würde nur Aufwand ohne echten
Sicherheitsgewinn bedeuten. Eine echte Lösung für Threat Model B (siehe
unten) wäre ein Architektur-Sprung über den R9-Rahmen hinaus und wurde
deshalb bewusst nicht umgesetzt.

**Was eine echte Threat-Model-B-Lösung bräuchte** (nicht Teil von R9, nicht
umgesetzt): ein Schritt, den ein reines HTTP-Skript grundsätzlich nicht
nachbilden kann, z. B. eine native OS-Bestätigung (Windows-Toast/MessageBox
mit echtem Mausklick, entkoppelt von HTTP) oder eine OS-Level-IPC-Kopplung
mit Zugriffskontrolle. Beides wäre ein eigenständiger Architekturentscheid
mit neuer OS-Interaktion, ausdrücklich nicht Teil dieses Auftrags.

**Was unverändert gilt, unabhängig vom Threat Model:**
`AI_ROUTER_APPROVAL_TOKEN` bleibt in jedem Fall ausschließlich serverseitig
im Prozessspeicher des AI-Routers. Er wird nie an Browser-JS ausgeliefert,
nie in HTML/Response-Bodies eingebettet und nie geloggt - das gilt für
Threat Model A genauso wie für das bewusst offene Threat Model B. Wer
Threat Model B ausnutzt, kann eine Run-Approval auslösen (eine "sichere
Simulation", siehe R8 Abschnitt 1), aber zu keinem Zeitpunkt den Token
selbst erlangen.

## 3. Fail closed ohne Token-Konfiguration

Ist `AI_ROUTER_APPROVAL_TOKEN` nicht gesetzt oder kürzer als 32 Zeichen,
lehnt der BFF-Endpoint jede Entscheidung ab - auch bei gültigem, frisch
konsumiertem Nonce. Die Antwort ist bewusst `403 APPROVAL_SOURCE_UNTRUSTED`,
nicht ein eigener Code: ein Aufrufer darf "kein Token konfiguriert" nicht als
von "falscher Token" unterscheidbare Information lernen (dieselbe R7-
Konvention, jetzt für beide Approval-Routen konsistent).

## 4. Gehärtete direkte Route

`POST /api/runs/:id/approval` verlangt jetzt exakt dieselbe Auth wie R7s
`/api/actions/:id/approval`: `Authorization: Bearer <AI_ROUTER_APPROVAL_TOKEN>`,
geprüft über `authenticateInternalRequest()` (bereits vorhandenes Modul,
keine neue Token-Familie). Fehlend → `401 APPROVAL_AUTH_REQUIRED`. Falsch
oder nicht konfiguriert → `403 APPROVAL_SOURCE_UNTRUSTED`. Das ist der Weg
für Operator-`curl`-Aufrufe; die Browser-Seite ruft ihn nicht mehr auf.

## 5. Rate Limit - bewusst nicht hinzugefügt

R8 hat bestätigt, dass eine genehmigte Run-Approval ausschließlich
`startApprovalSimulation()` auslöst - eine sichere Simulation, keinen realen
Executor, keine externen Side Effects (anders als Action-Approvals mit
`app.open`). Der neue BFF-Endpoint ist zusätzlich durch den Single-Use-Nonce
selbst strukturell gegen Wiederholung geschützt (jede Entscheidung braucht
einen frischen, unbenutzten Nonce). Ein zusätzlicher Rate-Limiter (wie R7s
`ACTION_APPROVAL_MAX_EXECUTIONS_PER_WINDOW`) wurde deshalb bewusst **nicht**
eingeführt - kein realer Side-Effect-Missbrauch, den er verhindern müsste,
und der Nonce deckt den Wiederholungsfall bereits ab.

## 6. Consumer-Umstellung

`01_APP/tests/ai-router-v0_13-test.html`s `decide()`-Handler ruft jetzt
`POST /api/runs/:id/approval/ui` statt der harten Route, sendet
`{decision, decisionNote, nonce}` und übernimmt aus der Antwort
`approvalNonce` als neuen Nonce für die nächste Entscheidung. Der bisherige
Direktaufruf der harten Route aus Browser-JS ist entfernt.

## 7. Audit

Neue `safeLog`-Events (kein Secret, keine Task-Inhalte):
`run_approval_rejected_auth`, `run_approval_received` (harte Route),
`run_approval_ui_rejected_nonce`, `run_approval_ui_rejected_auth`,
`run_approval_ui_received`, `run_approval_ui_forwarded` (BFF-Route).

## 8. Tests

`test/run-approval-bff.test.js` (12 Tests): Browser-Fluss über gültigen
Nonce (Approve/Reject), fehlender/wiederverwendeter/fremder Nonce → 401,
fehlende Token-Konfiguration → 403 fail-closed, unbekannte Run-ID → keine
Fake-Success, beliebige Zusatzfelder im Body werden ignoriert (kein
generischer Proxy), sowie die gehärtete direkte Route (401/403/200,
spiegelt R7s `test/action-approval-auth.test.js`). `test/router-console.test.js`
wurde an die neue, pro Request unterschiedliche Nonce im ausgelieferten HTML
angepasst (vorher byte-exakter Vergleich der ganzen Seite).

`test/run-approval-bff-threat-model.test.js` (1 Test, dauerhaft im Suite):
dokumentierter Grenztest für Threat Model B (Abschnitt 2a) - ein reiner
`fetch()`-Aufrufer ohne Browser, ohne `Origin`-Header, ohne
`AI_ROUTER_APPROVAL_TOKEN` führt `GET /` aus, extrahiert den Nonce per Regex
aus dem HTML-Body und approved damit erfolgreich einen wartenden Run über
die BFF-Route. Der Test erwartet **bewusst Erfolg** (`200`), nicht
Ablehnung - er hält den akzeptierten, dokumentierten Schutzumfang fest und
soll brechen, falls eine spätere Änderung diesen Bypass unabsichtlich
schließt oder öffnet, ohne dass dieses Dokument mit aktualisiert wird.

## 9. Was unverändert bleibt

* `/api/actions/:id/approval` (R7) unverändert.
* Kein neuer Prozess, kein neuer Port, kein CORS.
* Keine neue Token-Familie - `AI_ROUTER_APPROVAL_TOKEN` bleibt der einzige
  Approval-Token, jetzt für beide Routen.
* Kein genereller Proxy: die BFF-Route liest ausschließlich `decision`,
  `decisionNote`, `nonce` aus dem Body.

## 10. Offen für R10

* Threat Model B (Abschnitt 2a) bleibt bewusst offen - eine echte Lösung
  (native OS-Bestätigung oder IPC-Kopplung) wäre ein eigener
  Architekturentscheid außerhalb dieses Auftrags.
* `/api/runs` (create), `/api/runs/:id/cancel` u.a. bleiben weiterhin nur
  durch `isTrustedMutation()` geschützt - außerhalb des R9-Auftrags (nur die
  Approval-Trust-Boundary war Ziel). Sie unterliegen strukturell demselben
  Threat-Model-B-Vorbehalt wie die Approval-Route.
* Die verbliebenen R7-Restpunkte (Multi-Actor-Unterscheidung,
  Router-API-Allowlist-Migration) bleiben unverändert offen.
