# Changelog

## v0.11.0-test

- Zentralen, wiederverwendbaren Adaptervertrag (`adapter-contract.js`) fuer Ein- und Ausgaben eingefuehrt; keine zweite parallele Adapterstruktur.
- Codex-CLI-Erkennung um eine Versionspruefung erweitert; `CODEX_CLI_NOT_FOUND` und `CODEX_CLI_UNSUPPORTED` als eigene, sichere Fehlercodes ergaenzt.
- Arbeitsverzeichnis-Pruefung auf `WORKING_DIRECTORY_NOT_ALLOWED` vereinheitlicht; nicht existierende Pfade, Traversal und Junctions/Symlinks ausserhalb der Allowlist werden ohne Pfadleck abgelehnt.
- Kindprozess-Umgebung des Codex-Prozesses auf eine feste Allowlist begrenzt; beliebige Secrets aus der Server-Umgebung werden nicht mehr weitergegeben.
- Feste, serverseitige Sicherheitsanweisung vor jede Nutzeraufgabe gestellt; Versuche, sie per Aufgabetext zu ueberschreiben, bleiben reiner Analysetext.
- stdout/stderr-Begrenzung um eine explizite Kennzeichnung abgeschnittener Ausgabe (`stderr_truncated`) ergaenzt.
- Genau einen technischen Retry bei fehlgeschlagenem Codex-Prozessstart (`CODEX_PROCESS_START_FAILED`) ergaenzt; kein Retry nach Timeout, Abbruch, Policy-Verstoss oder Validierungsfehler.
- Nachkontrolle der Read-only-Garantie (`READ_ONLY_VIOLATION_DETECTED`) auch nach Abbruch eines echten Runs korrigiert; zuvor griff dafuer faelschlich der Mock-Abbruchpfad.
- `durationMs` je Run ergaenzt und in der API-Antwort unter `timestamps.durationMs` verfuegbar gemacht.
- Health-Endpunkt liest die Version jetzt aus der zentralen Konfiguration statt aus einer zweiten, fest kodierten Zeichenkette.
- Kontrollierte Fake-CLI- und Prozesstests fuer Erfolg, fehlende CLI, Startfehler, Exit-Code, stderr, Timeout, Abbruch, uebergrosse Ausgabe, genau einen Retry, Pfad-Traversal, simulierte Dateiveraenderung und Prompt-Injection ergaenzt; bestehende Mock-Workflows bleiben unveraendert funktionsfaehig.
- Ein echter Codex-End-to-End-Lauf bleibt standardmaessig deaktiviert und wurde in dieser Version nicht ausgefuehrt.

## v0.10.0-test

- Zentralen Request-Vertrag, Allowlists, Groessenlimits und kontrollierte Fehlercodes eingefuehrt.
- Einheitlichen, datensparsamen API-Response-Builder fuer Erfolg und Fehler ergaenzt.
- Run-Persistenz von Prompt, Kontext, Pfaden und Approval-Kontext bereinigt; strukturiertes, rotierendes Ereignislogging ergaenzt.
- Kontrollierten einmaligen Retry fuer technische Mock-Schrittfehler hinzugefuegt.
- Read-only-Cockpit-Status auf sichere Betriebsdaten ohne Aufgaben- oder Freigabeinhalte begrenzt.
- Vertrags-, Response-, Persistenz- und Retry-Tests ergaenzt; reale Aktionen bleiben nicht implementiert.

## v0.9.0-test

- Deterministische Workflow-Typen `direct`, `plan_execute` und `plan_execute_review` ergaenzt.
- Feste Mock-Rollen Planer, Ausfuehrer, Pruefer und Zusammenfuehrung sequenziell orchestriert.
- Schrittstatus, Fehler, Timeout, Abbruch und begrenzte Ergebnis-Metadaten persistiert.
- Approval-Gate so erweitert, dass ein Workflow erst nach Freigabe startet.
- Kompakte Workflow-Projektion fuer das Cockpit und v0.9-Testoberflaeche ergaenzt.

## v0.8.0-test

- Einmalig konsumierbare Freigabe oder Ablehnung pro Run-ID ergaenzt.
- Approval-Kontext mit Folgen, Systemen, Ressourcen und Rueckgaengigkeit vorbereitet.
- Freigabe startet ausschliesslich eine lokale Mock-Simulation ohne reale Aktion.
- Ablehnung endet ohne Adapterstart als `cancelled`.
- v0.8-Testoberflaeche fuer sichere lokale Freigabeentscheidungen ergaenzt.

## v0.7.0-test

- Deterministische lokale Routing-Engine mit festem Route-Plan-Schema ergaenzt.
- Aufgabenarten, Bewertungsstufen und Risikoregeln ueber Allowlists begrenzt.
- R3/R4-Aufgaben stoppen am Freigabe-Gate als `awaiting_approval`, ohne einen Adapter zu starten.
- Externe Zielrouten bleiben Metadaten; `mock` bleibt Standardausfuehrung.
- Route-Plan in Run Store, Cockpit-Kurzstatus und v0.7-Testoberflaeche integriert.

## v0.6.0-test

- Kontrollierten lokalen `mock`-Adapter fuer Run-, Timeout- und Abbruchtests ergaenzt.
- Lokalen Node-Orchestrator fuer begrenzte Codex-Read-only-Analysen angelegt.
- Repository-Allowlist, Git-Integritaetspruefung, Run-Status und JSONL-Auswertung ergaenzt.
- Lokalen JSON-Run-Store und atomische Cockpit-Kurzstatusdatei vorbereitet.
- Neue Testoberflaeche `ai-router-v0_6-test.html` und tests ohne Modellverbrauch angelegt.

## v0.5.1-test

- Neue Design-Testversion `ai-router-v0_5_1-test.html` angelegt.
- Dunkles Dashboard-Interface mit Schwarz/Grau-Farbpalette umgesetzt.
- Karten, Buttons, Formulare und Ergebnisbereiche visuell ueberarbeitet.
- Vertrauen, Risiko und Lernbonus als CSS-Chips dargestellt.
- Routing-, Lern- und Speicherlogik unveraendert gelassen.

## v0.5-test

- Neue Testversion `ai-router-v0_5-test.html` angelegt.
- Lernmodus-Schalter fuer optionale lokale Lernboni ergaenzt.
- Lernbonus je KI aus gespeicherten Bewertungen berechnet und vor finaler Sortierung angewendet.
- Bonuswirkung begrenzt auf maximal +15 Punkte und maximal 25 Prozent des bisherigen KI-Scores.
- Lernbonus-Karte mit Bewertungen, Durchschnitt und aktivem Bonus ergaenzt.
- KI-Auswertung um besten Durchschnitt und meiste positive Bewertungen erweitert.
- Bestehende v0.4-`localStorage`-Daten werden weiterverwendet.

## v0.4-test

- Neue Testversion `ai-router-v0_4-test.html` angelegt.
- Entscheidungsverlauf mit Datum, Projektmodus, Arbeitsmodus, Aufgabe, Empfehlung, Vertrauen, Risiko und Workflow in `localStorage` ergaenzt.
- Bewertungssystem fuer Verlaufseintraege mit Gut, Mittel und Schlecht eingebaut.
- KI-Auswertung mit Empfehlungszaehlung, Durchschnittsbewertung und bester KI laut Bewertungen ergaenzt.
- Lernbasis mit empfohlener KI und Nutzerbewertung vorbereitet.
- Datenverwaltung fuer Verlauf loeschen und Statistik zuruecksetzen mit Sicherheitsabfrage ergaenzt.

## v0.3-test

- Neue Testversion `ai-router-v0_3-test.html` angelegt.
- Prompt Engine fuer automatisch erzeugte, kopierbare Prompts zur Top-Empfehlung ergaenzt.
- Arbeitsmodus-Dropdown fuer Analyse, Bugfix, Feature, Refactor, Deployment und Research eingebaut.
- Projektregeln fuer Allgemein, Plateau-Brecher, Kalorien-App und Social-Media-App in Ergebnis und Prompt integriert.
- Workflow-Vorschlaege nach Arbeitsmodus ergaenzt, z. B. Feature: Claude -> Codex -> ChatGPT.

## v0.2-test

- Neue Testversion `ai-router-v0_2-test.html` angelegt.
- Einzelempfehlung durch Top-3-KI-Ranking mit Prozentwerten ersetzt.
- Vertrauenswert auf Basis erkannter Schluesselwoerter eingebaut.
- Projektmodus-Dropdown fuer Allgemein, Plateau-Brecher, Kalorien-App und Social-Media-App ergaenzt.
- Detaillierte Begruendung mit erkannten Kriterien und Workflow-Vorschlag umgesetzt.

## v0.1-test

- Neues Mini-Projekt `09_AI_ROUTER` angelegt.
- Lokale Ein-Datei-HTML-App `AI Router` erstellt.
- Keyword-basierte KI-Empfehlung fuer Codex, Claude, ChatGPT und Gemini/ChatGPT eingebaut.
- Ausgabe mit Empfehlung, Begruendung, Risikostufe und kopierbarem Prompt umgesetzt.
- Mobile-freundliches Layout ohne externe Libraries erstellt.
