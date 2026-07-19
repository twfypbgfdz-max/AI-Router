# AI Router

Lokale HTML-Test-App zur einfachen Empfehlung eines passenden KI-Tools fuer eine Aufgabe.

## Version

Aktuelle Testversion: `v0.13.0-test`

## Cockpit-Router-API v1

Die neue, rein simulierende Cockpit-Schnittstelle nimmt versionierte Anfragen
ueber `POST /api/router/route` an. Sie validiert Eingaben, bestimmt eine
fachliche Route, prueft eine geschlossene Aktions-Allowlist und liefert Erfolge
wie Fehler im selben Grundformat zurueck. `GET /api/router/status` und
`GET /api/router/actions` stellen sichere Betriebs- und Allowlist-Metadaten
bereit. Die bestehenden Run-, Provider-, Diagnose- und Cockpit-Status-APIs
bleiben unveraendert. Router-CORS gilt nur fuer eine feste Cockpit-Origin-
Allowlist; die engere Origin-Regel bestehender Mutationsendpunkte wird dadurch
nicht erweitert. `execute` bleibt vollstaendig deaktiviert und alle Aktionen
bleiben reine Simulationen.

Architektur, Datenfluss, Vertraege, Routen, Beispiele und Testbefehle sind in
[`docs/router-api-v1.md`](docs/router-api-v1.md) dokumentiert.

## Simulierte Multi-Provider-Schicht v0.13

v0.13 fuehrt eine zentrale, rein lokale Provider-Schicht ein. Der Router kann
mehrere KI-Anbieter beziehungsweise Anbieterklassen einheitlich beschreiben,
auswaehlen, simulieren und orchestrieren. **Es wird keine echte Claude-,
OpenAI-, Gemini- oder andere externe API angebunden oder aufgerufen.** Es gibt
keine API-Schluessel, kein SDK, keinen Netzwerkzugriff und keine neuen
npm-Abhaengigkeiten. Codex bleibt ausschliesslich lokal read-only gemaess v0.11.

### Begriffe

- **Provider**: ein Anbieter oder eine Anbieterklasse (`mock`, `codex`, `claude`,
  `openai`, `gemini`).
- **Adapter**: die konkrete Ausfuehrungsschicht (`mock`, `codex-cli-readonly`).
- **Model**: eine Modellkennung/-klasse — in v0.13 nur Metadaten und Simulation.
- **Role**: die Aufgabe im Workflow (`planner`, `executor`, `reviewer`,
  `synthesizer`).
- **Route**: welcher Provider/Adapter fuer welche Rolle vorgesehen ist.

### Providerprofile

Zentral begrenzte, erlaubte Provider-IDs:

- `mock-local` — neutraler, deterministischer Baseline-Provider (Simulation,
  ausfuehrbar).
- `codex-local-readonly` — realer, lokaler Read-only-Codex-Provider (kein
  Modelllauf ausser dem bestehenden v0.11-Pfad).
- `claude-simulated`, `openai-simulated`, `gemini-simulated` — **reine lokale
  Simulationen** eines Anbieterprofils. Sie rufen nichts Externes auf.

Nur `mock-local` und `codex-local-readonly` sind technisch ausfuehrbar. Die
Simulationsprofile sind nie ausfuehrbar und binden nie den realen Codex-Adapter.

### Auswahl

- **Automatisch**: der Router waehlt deterministisch. Standardausfuehrung ist die
  sichere Mock-Simulation; das am besten passende Spezialprofil wird als
  Empfehlung (Alternativen/Begruendung) angezeigt, aber nicht still ausgefuehrt.
- **Manuell**: `requestedProvider` (optional, normalisiert, groessenbegrenzt,
  gegen die Registry-Allowlist geprueft) waehlt ein erlaubtes, aktiviertes
  Profil. Passt es nicht (Faehigkeit/Rolle/Aufgabe), gibt es einen kontrollierten
  Fehler (`PROVIDER_CAPABILITY_MISMATCH`, `PROVIDER_ROLE_NOT_SUPPORTED`,
  `PROVIDER_TASK_NOT_SUPPORTED`) — nie eine stille Ausfuehrung.

### Provider-Fallback

Bei einer inkonsistenten Registry oder einer Rolle, die der gewaehlte Provider
nicht bedienen kann, faellt der Router **sichtbar** auf die Mock-Simulation
zurueck (`providerFallbackUsed`, Warnung). Es gibt **keinen** stillen Fallback von
einem nicht erlaubten Provider auf einen echten ausfuehrbaren Adapter. Das
Freigabe-Gate wird durch Provider-Auswahl oder Fallback niemals umgangen.

### Workflow-Profile

- `single_provider` — alle Rollen derselbe Provider.
- `specialist_chain` — Planner/Executor/Reviewer koennen verschiedene simulierte
  Provider haben; Synthese lokal.
- `safe_review_chain` — Ausfuehrung durch die sichere Mock-Simulation, Pruefung
  durch einen simulierten Reviewer, finale Synthese lokal.

In v0.13 bleibt die Standardausfuehrung fuer Multi-Provider-Workflows die
vollstaendige Simulation. Eine als `codex-local-readonly` bezeichnete Rolle
innerhalb einer simulierten Kette ist ebenfalls simuliert; ein realer
Codex-Read-only-Lauf erfolgt ausschliesslich ueber den bestehenden
Einzel-Adapter-Codex-Pfad. Keine Parallelisierung, keine rekursiven Workflows,
keine dynamischen Rollen; die Schrittzahl ist zentral begrenzt.

### Gespeicherte und nicht gespeicherte Daten

Gespeichert werden nur begrenzte Provider-Metadaten (z. B. `selectedProviderId`,
`selectedModelId`, `providerWorkflowProfile`, `providersUsed`, `providerCount`,
`simulatedProviderCount`, `realLocalAdapterUsed`, `providerSelectionMode`,
`providerFallbackUsed`, `providerWarningsCount`). **Nicht** gespeichert werden
Provider-Rohantworten, vollstaendige Zwischenergebnisse, Nutzer- oder
Rollenprompts, Tokens, Preise, Zugangsdaten, externe Request-IDs oder
stdout/stderr. Historie und Detailansicht bleiben datensparsam; alte Run-Dateien
ohne Provider-Felder bleiben lesbar und werden sicher als `null`/`false`/leer
behandelt.

### Provider-Endpunkte (read-only)

- `GET /api/providers` — sichere Providerliste.
- `GET /api/providers/:providerId` — sichere Provider-Metadaten
  (unbekannt → `404 PROVIDER_NOT_FOUND`).
- `POST /api/providers/select` — reine lokale Vorschau der Provider-Auswahl,
  keine Ausfuehrung.
- `POST /api/runs` akzeptiert zusaetzlich das optionale Feld `requestedProvider`
  (und `providerProfile`).

Health, Diagnose und Cockpit zeigen nur sichere Provider-Aggregate
(Registry-Status, Provider-/Aktiv-/Simuliert-/Ausfuehrbar-Zaehler, kleine
Statusliste) — keine Modelle, Pfade, Secrets oder Konfiguration.

### Bekannte Grenzen v0.13

- Es wurden **keine** echten externen Anbieter getestet oder angebunden.
- Die automatische Auswahl fuehrt bewusst die sichere Mock-Simulation aus und
  benennt Spezialprofile nur als Empfehlung; Spezialisten-/Review-Ketten werden
  ausdruecklich ueber `providerProfile` gewaehlt.
- Ein visueller Browser-Test war in der Umgebung nicht moeglich (kein
  Browser-Automations-Tool); die UI wurde statisch geprueft und ueber die
  identischen API-Aufrufe der UI verifiziert.
- Der echte Codex-End-to-End-Test bleibt standardmaessig deaktiviert.

## Betrieb, Diagnose und Transparenz v0.12

v0.12 macht den Router lokal besser ueberpruefbar, ohne neue echte Anbieter
oder riskante Aktionen. Es wurden keine Claude-, ChatGPT- oder Gemini-APIs und
keine externen Aktionen ergaenzt.

**Sichtbare Betriebsdaten (bewusst begrenzt):** Pro Run werden ausschliesslich
sichere Metadaten angezeigt und indiziert: `runId`, `requestId`, `schemaVersion`,
`route`, `adapter`, `workflowType`, `status`, `success`, `riskLevel`,
`approvalState`, `retryCount`, `startedAt`, `finishedAt`, `durationMs`,
`safeErrorCode`, `warningsCount` und `resultAvailable` (Boolean).

**Bewusst nicht sichtbar/gespeichert:** Aufgaben-Volltext, Rohprompts,
vollstaendige Kontextdaten, Datei-Inhalte, stdout, stderr, lokale Pfade,
Secrets, Tokens und vollstaendige Tool-Ausgaben. Die zentrale Projektion
`orchestrator/run-summary.js` ist die einzige Run-Darstellung, die den Prozess
fuer Historie, Detailansicht und Diagnose verlaesst.

**Health (`GET /api/health`):** liefert `serviceStatus`, `version`,
`schemaVersion`, `uptimeSeconds`, `serverTime`, `activeRuns`,
`awaitingApprovalRuns`, `queuedRuns`, `lastSuccessfulRunAt`, `lastFailedRunAt`,
`lastSafeErrorCode`, `adapterStatus`, `storageStatus` und `loggingStatus`. Der
Service gilt als `degraded`, sobald Speicher oder Logging nicht `ok` sind.

**Diagnose (`GET /api/diagnostics`):** liefert nur zusammengefasste
Betriebsdaten – Version/Schema, Runs nach Status, Fehler nach sicherem
Fehlercode, durchschnittliche Dauer, Retries, Timeouts, Abbrueche,
Log-Vorhandensein, grobe Loggroessenklasse (`none`/`small`/`medium`/`large`,
keine exakte Groesse, kein Pfad), Run-Store-Verfuegbarkeit und Adapterstatus.
Keine Rohlogs, kein Log-Download, keine Pfade, keine Schreibfunktion.

**Run-Historie (`GET /api/history`, `GET /api/history/:id`):** neueste zuerst,
mit `limit`/`offset` und Filtern nach `status`, `adapter` sowie Zeitraum
(`since`/`until`). Die Historie wird auf `MAX_HISTORY_RUNS` (200) im Index
begrenzt; aeltere Eintraege fallen nur aus dem Index, es werden keine Run-Dateien
geloescht. Ein Standardlimit von 25 und ein Maximallimit von 100 gelten pro
Abfrage. Unbekannte Run-IDs werden mit einem kontrollierten `RUN_NOT_FOUND`
beantwortet.

**Adapter-Verfuegbarkeit:** Die Zustaende sind `unchecked`, `checking`,
`available`, `unavailable` und `unsupported`. Die Codex-Pruefung wird nicht bei
jedem Seitenaufruf teuer wiederholt, sondern hoechstens einmal je Cache-Fenster
(`ADAPTER_STATUS_CACHE_MS` = 60 Sekunden); gleichzeitige Pruefungen teilen sich
einen Lauf. Eine manuelle erneute Pruefung ist ueber `POST /api/adapters/check`
moeglich. Es erfolgt keine Installation und keine Konfigurationsaenderung. Der
Mock-Adapter gilt nur bei valider interner Konfiguration als `available`.

**Cockpit-Vertrag (`GET /api/cockpit-status`):** stabil und rein lesend. Er
liefert die kanonischen v0.12-Felder `reachable`, `serviceStatus`, `version`,
`activeRuns`, `awaitingApprovalRuns`, `lastSuccessfulRunAt`, `lastSafeErrorCode`,
`mockAvailable`, `codexReadOnlyStatus` und `checkedAt`. Er liefert keine
Run-Listen, Aufgabeninhalte, Prompts, Ergebnisse, Logs, Approval- oder
Abbruchsteuerung und keinen Schreibzugriff.

**Voruebergehende Rueckwaertskompatibilitaet (v0.12.1, veraltet):** Da das
Felix-Cockpit noch nicht auf die neuen Feldnamen umgestellt ist, liefert der
Vertrag zusaetzlich vier **veraltete, nur voruebergehend gepflegte Aliasfelder**,
die ausschliesslich aus den kanonischen Feldern abgeleitet werden und keine
weiteren oder sensiblen Daten enthalten:

- `routerVersion` = `version`
- `activeOrWaitingRuns` = `activeRuns` + `awaitingApprovalRuns`
- `updatedAt` = `checkedAt`
- `lastRunStatus` = letzter sicher bekannter Run-Status (fester Enumwert) oder
  `null`

Diese Aliasfelder sind ausdruecklich als Uebergangsloesung gedacht und sollen
entfallen, sobald das Cockpit die v0.12-Feldnamen (`version`, `activeRuns`/
`awaitingApprovalRuns`, `checkedAt`) liest. Neue Konsumenten sollen die
kanonischen v0.12-Felder verwenden.

**Logging:** Zusaetzliche sichere Betriebs-Events (u. a. `server_started`,
`health_checked`, `diagnostics_checked`, `adapter_check_*`, `run_listed`,
`run_details_viewed`, `run_cancel_*`). Logs enthalten weiterhin keine
Tasktexte, Prompts, Datei-Inhalte, stdout/stderr, Secrets, lokalen Pfade oder
vollstaendigen Header; Werte werden maskiert. Die Logdatei rotiert bei etwa
512 KB.

**Datenhaltung und Fehlerfaelle:** Bei beschaedigtem Run-Store, nicht
beschreibbarem Datenordner oder Logging-Ausfall stuerzt der Router nicht ab. Er
liefert einen sicheren, ehrlichen Status (`degraded`/`unavailable`), erfindet
keine Daten und laeuft, soweit moeglich, im eingeschraenkten Modus weiter. Es
gibt keine automatische aggressive Bereinigung und kein Loeschen von Dateien.

### Bekannte Grenzen v0.12

- Health, Cockpit und Snapshot spiegeln die Live-Daten des aktuellen
  Prozesses; die Diagnose-Aggregate stammen aus dem persistierten, begrenzten
  History-Index und ueberdauern Neustarts.
- Der Cockpit-`serviceStatus` ist ein minimaler Lebenszeichenwert; die
  autoritative Degradationsbewertung liefert `GET /api/health`.
- Ein echter Codex-End-to-End-Lauf bleibt standardmaessig deaktiviert und wurde
  auch in v0.12 nicht ausgefuehrt.

## Vertrags- und Sicherheitsbasis v0.10

`POST /api/runs` normalisiert Eingaben auf Schema `1`: `requestId`, `task`,
`project`, `requestedMode`, `requestedAdapter`, `source`, `context`, `options`
und `createdAt`. `task` ist Pflicht; unbekannte Felder werden verworfen.
Erlaubt sind nur die Adapter `mock` und `codex-cli`, die Modi `simulation` und
`read-only`, die Quellen `ui`, `api`, `cockpit`, `local` sowie die sicheren
Action-Typen Analyse, Planung, Pruefung, Zusammenfuehrung, Simulation und
Read-only-Codex. Andere Werte werden mit einem kontrollierten Fehler abgelehnt.

Alle API-Antworten verwenden ein gemeinsames Grundformat mit `schemaVersion`,
`requestId`, `runId`, `status`, `success`, `routePlan`, `workflow`, `result`,
`error`, `warnings` und Zeitstempeln. `result` und `error` sind gegenseitig
ausschliessend. Fehler enthalten nur Code, sichere Nachricht, Retry-Hinweis,
sichere Details und Zeitstempel; keine Stacktraces oder lokalen Pfade.

Run-Dateien speichern keine Aufgaben, Kontexte, Repository-Pfade,
Ausfuehrungsdateien oder Approval-Kontexte. Strukturierte Ereignislogs liegen
nicht versioniert unter `.ai-router-data/router-events.jsonl`; sie enthalten
keine Prompt-Volltexte, Secrets, Datei-Inhalte oder Tool-Ausgaben und werden
bei etwa 512 KB einfach rotiert.

Bei einem technischen Mock-Schrittfehler erfolgt genau ein Retry. Validierung,
Allowlist-Ablehnungen, Timeouts und fehlende Freigaben werden nicht wiederholt.
Der Retry-Zaehler und die Ursache stehen im Run. Das Freigabe-Gate bleibt auch
beim Retry unveraendert: Es startet ausschliesslich die sichere Mock-Simulation.

`GET /api/cockpit-status` ist bewusst nur lesend. Es liefert Erreichbarkeit,
Router-Version, letzten Run-Status, aktive/wartende Runs, Zeitpunkt des letzten
Erfolgs und den letzten sicheren Fehlercode – keine Aufgabe, Prompts,
Tool-Ausgaben oder Freigabesteuerung.

## Codex-Adaptervertrag und Haertung v0.11

Der Codex-Adapter nutzt einen zentralen, wiederverwendbaren Adaptervertrag
(`orchestrator/adapter-contract.js`) statt einer zweiten parallelen Struktur.
Eingaben (`adapter`, `requestId`, `runId`, `taskType`, `safeInstruction`,
`workingDirectory`, `timeoutMs`, `maxOutputBytes`, `retryAttempt`) und
Ausgaben (`adapter`, `status`, `success`, `exitCode`, `startedAt`,
`finishedAt`, `durationMs`, `retryable`, `result`, `error`, `warnings`,
`safeMetadata`) werden geprueft, normalisiert und eingefroren. `durationMs`
wird bei jedem beendeten Run aus `startedAt`/`finishedAt` berechnet und in der
API-Antwort unter `timestamps.durationMs` mitgeliefert.

**CLI-Erkennung:** Vor jedem echten Lauf wird die konfigurierte oder
zulaessige Codex-CLI probeweise mit `--version` gestartet; die Ausgabe muss
als Codex-CLI-Version erkennbar sein. Fehlt die CLI vollstaendig, meldet der
Router `CODEX_CLI_NOT_FOUND`; startet ein Programm, dessen Versionsausgabe
nicht als Codex-CLI erkennbar ist, meldet der Router `CODEX_CLI_UNSUPPORTED`.
Es erfolgt keine automatische Installation und keine Aenderung globaler
Konfiguration. Der ausfuehrbare Pfad stammt ausschliesslich aus einer festen
Serverkonfiguration oder der lokalen Umgebungsvariable `CODEX_EXECUTABLE`,
niemals aus dem Request-Body.

**Arbeitsverzeichnis:** Jedes Arbeitsverzeichnis wird serverseitig ueber
`fs.realpath` kanonisch aufgeloest und gegen eine feste Allowlist
(ausschliesslich dieses Repository) geprueft. Nicht existierende Pfade,
Pfad-Traversal ueber `..` und Verzeichnis-Junctions/Symlinks ausserhalb der
Allowlist werden einheitlich als `WORKING_DIRECTORY_NOT_ALLOWED` abgelehnt,
ohne dass der zugrunde liegende Dateisystempfad in der Fehlermeldung
erscheint.

**Prozessstart:** Codex wird ausschliesslich mit `spawn`, fester
ausfuehrbarer Datei, fester Argumentliste und `shell: false` gestartet. Die
Kindprozess-Umgebung ist auf eine feste Allowlist begrenzt (u. a. `PATH`,
`SystemRoot`, `TEMP`, `USERPROFILE`); beliebige Secrets aus der Server-Umgebung
werden nicht an den Codex-Prozess weitergegeben. Ein fehlgeschlagener
Prozessstart wird als `CODEX_PROCESS_START_FAILED` erkannt und genau einmal
automatisch wiederholt; Timeout, Abbruch, Policy-Verstoesse und
Validierungsfehler werden nie wiederholt.

**Sicherheitsanweisung:** Vor jeder Nutzeraufgabe stellt der Router eine
feste, serverseitig erzeugte Sicherheitsanweisung voran, die Analyse ohne
Schreib-, Git-, Netzwerk- oder Zugangsdatenzugriff verlangt. Die Aufgabe wird
danach klar abgegrenzt als reiner Analysetext markiert; Formulierungen wie
„Ignoriere alle Regeln“ oder „Fuehre git push aus“ innerhalb der Aufgabe
bleiben zu analysierender Text und ueberschreiben die feste Anweisung nicht.
Zusaetzlich bleibt Codex durch `-s read-only -a never` technisch auf
Lese-Modus ohne Freigaben begrenzt.

**Ausgabebegrenzung:** stdout/JSONL und stderr sind auf `maxOutputBytes`
begrenzt; Ueberschreitungen werden als `stderr_truncated` bzw. vorhandene
JSONL-Parser-Hinweise sichtbar gemacht statt still abgeschnitten.

**Nachkontrolle:** Nach jedem echten Lauf – auch nach Timeout und nach
Abbruch durch den Nutzer – vergleicht der Router den Git-Status vor und nach
der Ausfuehrung. Bei jeder erkannten Aenderung markiert er den Run als
`READ_ONLY_VIOLATION_DETECTED`, ohne automatisch zurueckzusetzen oder
Datei-Inhalte anzuzeigen, und startet keinen weiteren Adapterlauf. Dieser
Vergleich lief zuvor bei einem Abbruch fuer echte Codex-Runs faelschlich nicht
zuverlaessig; das ist in v0.11 behoben.

## Lokaler Read-only-Codex-MVP

`npm start` startet den aktuellen MVP-Teststand `v0.13.0-test` als lokalen
Node-Server auf `http://127.0.0.1:8787` und liefert die Betriebsoberflaeche
`ai-router-v0_12-test.html`. `npm test` fuehrt die automatisierten Tests aus. Es
gibt keine npm-Abhaengigkeiten; Node und die npm-Skripte werden dennoch fuer
Start und Tests verwendet.
Der MVP kann eine Analyseaufgabe entweder kontrolliert simulieren oder nach
bewusster Auswahl an die lokale Codex-CLI senden. Die Codex-Ausfuehrung ist
fest auf `read-only` begrenzt, verwendet keine Websuche und akzeptiert nur
dieses AI-Router-Repository. Laufdaten liegen nicht versioniert unter
`.ai-router-data/`. Schreibzugriff, Commits, Pushes und Deployments sind nicht
implementiert.

### Lokale Simulation

Die Testoberflaeche startet standardmaessig den Adapter `mock`. Er simuliert
kontrolliert erfolgreiche, fehlgeschlagene und zeitueberschreitende Runs, ohne
einen Prozess, Netzwerkzugriff oder ein externes Modell zu starten. `codex-cli`
wird nur nach ausdruecklicher Auswahl verwendet und bleibt Read-only.

### Deterministischer Route-Plan v0.7

Vor jedem Run klassifiziert eine lokale Regel-Engine die Aufgabe und speichert
Aufgabenart, empfohlene Route, tatsaechlichen Adapter, Begruendung, Komplexitaet,
Wichtigkeit, Risiko, Unsicherheit, erwarteten Verbrauch sowie Pruef- und
Freigabebedarf. Empfehlungen fuer Codex, ChatGPT oder Claude sind Metadaten und
starten keinen externen Dienst. Standardausfuehrung bleibt `mock`.

Riskante Aktionen werden mindestens als `R3`, produktive oder destruktive
Aktionen als `R4` eingestuft. Sie erhalten ein Freigabe-Gate und koennen nur
als Route-Plan gespeichert werden. Der Run stoppt als `awaiting_approval`, ohne
einen Adapter zu starten, und der Router behauptet dabei keine Ausfuehrung.

### Lokales Freigabe-Gate v0.8

Ein Run in `awaiting_approval` kann genau einmal fuer seine eigene Run-ID
freigegeben oder abgelehnt werden. Die Entscheidung, optionale Notiz und
Zeitpunkte werden im Run Store protokolliert. Ablehnung endet ohne Adapterstart
als `cancelled`. Freigabe startet ausschliesslich eine lokale Mock-Simulation;
es gibt auch danach keine echte riskante Aktion, Shell oder externe API.

### Mehrstufiger Mock-Workflow v0.9

Der Router waehlt deterministisch `direct`, `plan_execute` oder
`plan_execute_review`. Abhaengig vom Typ durchlaeuft ein Run die festen Rollen
Planer, Ausfuehrer, Pruefer und Zusammenfuehrung. Rollen laufen ausschliesslich
nacheinander; es gibt keinen parallelen Rollenbetrieb und keine dynamischen
Rollennamen.

Jede Rolle wird nur lokal durch Mock simuliert. Schrittresultate sind begrenzt,
maskiert und enthalten keine Chats, Rohprompts, Tool-Ausgaben oder Dateiinhalte.
Riskante Aufgaben bleiben bis zur Freigabe ungestartet. Auch nach Freigabe laeuft
nur der Mock-Workflow ohne externe KI, Shell oder reale Aktion. Echte
Multi-KI-Orchestrierung folgt erst in einer spaeteren Ausbaustufe.

Bei einem Schritt-Timeout endet der Run als `timed_out`; der Workflow selbst
endet innerhalb seiner festen Status-Allowlist als `failed`, und alle offenen
Schritte werden uebersprungen.

### Bekannte Grenze

Der synthetische End-to-End-Integrationstest ist vorbereitet und standardmaessig
deaktiviert. Ein echter Codex-Modelllauf ist noch nicht vollstaendig End-to-End
bestaetigt, weil die installierte CLI keine harte Read-Root-Isolation auf nur das
synthetische Test-Repository garantiert.

## Historische v0.5.1-Demo

`ai-router-v0_5_1-test.html` bleibt als historische, rein lokale HTML-Demo
erhalten. Sie ist nicht der aktuelle MVP-Startweg und startet keine Codex-CLI.

Die historische Demo benoetigt keinen Node-Server. Der aktuelle v0.6-MVP
benoetigt dagegen den lokalen Node-Orchestrator, aber keine externen Libraries.

## Routing v0.5

- Codex: Bug, Fehler, CSS, HTML, JS, Git, Commit, Repo, Datei aendern
- Claude: Konzept, Architektur, UX, grosses Feature, Refactor-Plan
- ChatGPT: Erklaerung, Text, Entscheidung, Prompt, Einschaetzung
- Gemini oder ChatGPT: Recherche, aktuelle Informationen, Vergleiche

## Funktionen v0.2

- Top-3-KI-Ranking mit Prozentwerten
- Vertrauenswert von 0 bis 100 Prozent
- Projektmodus: Allgemein, Plateau-Brecher, Kalorien-App, Social-Media-App
- Erkannte Kriterien als Begruendungsliste
- Workflow-Vorschlag in empfohlener Reihenfolge

## Funktionen v0.3

- Prompt Engine mit automatisch erzeugtem Prompt zur Top-Empfehlung
- Arbeitsmodus: Analyse, Bugfix, Feature, Refactor, Deployment, Research
- Projektregeln fuer Allgemein, Plateau-Brecher, Kalorien-App und Social-Media-App
- Workflow-Vorschlag nach Arbeitsmodus, z. B. Feature: Claude -> Codex -> ChatGPT
- Prompt-Kopierfunktion bleibt lokal ohne API, Backend oder externe Libraries

## Funktionen v0.4

- Entscheidungsverlauf in `localStorage`
- Nachtraegliche Bewertung je Verlaufseintrag: Gut, Mittel, Schlecht
- KI-Auswertung mit Empfehlungszaehlung und Durchschnittsbewertung je KI
- Beste KI laut gespeicherten Bewertungen
- Lernbasis vorbereitet mit empfohlener KI und Nutzerbewertung
- Datenverwaltung fuer Verlauf und Statistik mit Sicherheitsabfrage

## Funktionen v0.5

- Lernmodus Ein/Aus fuer lokale Zusatzbewertung
- Lernbonus je KI aus gespeicherten Bewertungen
- Bonus bleibt begrenzt: maximal +15 Punkte und maximal 25 Prozent des bisherigen KI-Scores
- Kein Lernbonus bei weniger als 3 Bewertungen
- Transparente Lernbonus-Karte mit Bewertungen, Durchschnitt und aktivem Bonus
- Erweiterte KI-Auswertung mit bestem Durchschnitt und meisten positiven Bewertungen

## UI v0.5.1

- Dunkles Dashboard-Design
- Schwarz/Grau-Farbpalette
- Groessere Kartenrundungen und klarere Abstaende
- Chip-Darstellung fuer Vertrauen, Risiko und Lernbonus
- Mobile-freundliche Controls und Buttons
