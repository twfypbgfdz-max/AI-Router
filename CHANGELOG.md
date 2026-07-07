# Changelog

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
