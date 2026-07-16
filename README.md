# AI Router

Lokale HTML-Test-App zur einfachen Empfehlung eines passenden KI-Tools fuer eine Aufgabe.

## Version

Aktuelle Testversion: `v0.11.0-test`

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

`npm start` startet den aktuellen MVP-Teststand `v0.10.0-test` als lokalen
Node-Server auf `http://127.0.0.1:8787`. `npm test` fuehrt die automatisierten
Tests aus. Es gibt keine npm-Abhaengigkeiten; Node und die npm-Skripte werden
dennoch fuer Start und Tests verwendet.
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
