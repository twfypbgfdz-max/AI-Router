# Recommendation Engine v1

## Zweck und Architektur

Die Recommendation Engine erzeugt kurze, nachvollziehbare Workflow-
Empfehlungen aus bereits belegten Dashboard-Statusdaten. Sie erweitert den
bestehenden Router und verwendet dessen HTTP-, CORS-, Fehler- und Logging-
Grenzen; es gibt keinen parallelen zweiten Router. Die Berechnung ist lokal,
zustandslos und ohne Netzwerkzugriff.

Die spätere Dashboard-Anbindung kann den normalisierten Kontext per
`POST /api/router/recommendations` übergeben und das Ergebnis anzeigen. `POST`
dient nur dazu, den begrenzten Eingabekörper zu übertragen. Der Endpunkt führt
keine Mutation aus und speichert den Inhalt nicht.

## Eingabeschema

Das veröffentlichte Schema liegt unter
`schemas/recommendation-input-v1.json`. Die Schema-Version ist `1.0`, der Modus
muss `observe` sein. Der normalisierte Input enthält:

- Projekt-ID, Projektname, Projektstatus und Project-Evidence
- Quality-Gesamtstatus sowie Test-, Build-, Release-, Dokumentations- und
  Deploymentstatus
- dokumentierte Versionsrollen (`development`, `stable`, `release`), ohne
  Werte abzuleiten oder zu ergänzen
- begrenzte AI-Job-Freshness-Daten und Alerts
- die explizite Dashboard-Workflow-Allowlist mit `read-only` oder
  `prepare-only`
- einen Evidence-Status und Evidence-Zeitstempel je entscheidungsrelevantem
  Zustand

Evidence-Status kennt ausschließlich `available`, `unknown` und
`unavailable`. `available` benötigt einen gültigen, nicht zukünftigen
ISO-Zeitstempel. Ungültige oder zukünftige Evidence wird defensiv zu
`unavailable`. Fehlende Felder werden nicht geraten. Freie Texte, unbekannte
Felder, Alert-Codes und Statuswerte werden ausschließlich als Daten behandelt;
unbekannte Statuswerte können keine Regel aktivieren.

Grenzen: maximal 32 KiB Request-Body, 30 Workflows, 30 Alerts und 20 AI-Jobs.
Projekt-/Workflow-IDs, Texte und Arrays besitzen zusätzliche Feldlimits. Es
werden keine Logs, Dateiinhalte, Pfade, E-Mail-Adressen, Secrets oder Tokens
benötigt oder zurückgegeben.

## Ausgabeschema

Das Schema liegt unter `schemas/recommendation-output-v1.json`. Das Ergebnis
enthält höchstens eine primäre Empfehlung und höchstens zwei Alternativen. Jede
Empfehlung enthält:

- `recommendationId`, `projectId`, `workflowId`
- `title`, `summary`, `reasonCodes`
- die konkret verwendeten `evidence`-Felder
- `confidence`, `safetyLevel`, `mode`
- `blockedReasons`, `missingEvidence`, `generatedAt`

`recommendationId` wird deterministisch aus Schema, Projekt, Regel und
Workflow gebildet. `generatedAt` beschreibt nur die Erzeugung und beeinflusst
die fachliche Entscheidung nicht. `execution.allowed` und
`execution.performed` sind immer `false`. Es gibt kein Action-, Command-,
Prompt- oder Execution-Objekt.

## Prioritätsregeln

Die erste belegte Regel mit einem passenden erlaubten Workflow wird primär:

1. belegter kritischer Sicherheitsblocker: keine Empfehlung
2. fehlgeschlagene Tests: `assess-test-status`
3. stale oder blockierte Quality-Evidence: `check-project-status`
4. belegbar blockierte, nicht bereite oder prüfpflichtige Release-Readiness:
   `assess-release-readiness`
5. stale, unvollständige oder widersprüchliche Dokumentation:
   `check-documentation-gaps`
6. stale Evidence eines geplanten/laufenden AI-Jobs: `check-project-status`
7. explizit belegter Folgeauftrag: `prepare-codex-prompt` als `prepare-only`
8. andernfalls: kein belegbarer Handlungsbedarf und keine Empfehlung

Eine Regel gilt nur mit `evidence.status: "available"`. `unknown` und
`unavailable` sind keine Fehler. Ein fehlender Build ist kein fehlgeschlagener
Build, `unreleased` ist kein Release-Fehler und `ready` wird nur als gelieferter
belegter Status akzeptiert. Fehlt der benötigte Workflow in der Dashboard-
Allowlist, entsteht keine Empfehlung. `execute`, `write` und unbekannte
Sicherheitsstufen werden ausgeschlossen.

## Beispiel mit belegbarer Empfehlung

```json
{
  "schemaVersion": "1.0",
  "mode": "observe",
  "project": { "id": "ai-router", "name": "AI Router", "status": "ok", "evidence": { "status": "available", "timestamp": "2026-07-19T09:00:00Z" } },
  "quality": {
    "status": { "status": "warning", "evidence": { "status": "available", "timestamp": "2026-07-19T09:00:00Z" } },
    "tests": { "status": "failed", "evidence": { "status": "available", "timestamp": "2026-07-19T09:00:00Z" } },
    "build": { "status": "unknown", "evidence": { "status": "unknown", "timestamp": null } },
    "versions": { "development": null, "stable": null, "release": null, "evidence": { "status": "unknown", "timestamp": null } },
    "releaseReadiness": { "status": "unknown", "evidence": { "status": "unknown", "timestamp": null } },
    "documentation": { "status": "complete", "evidence": { "status": "available", "timestamp": "2026-07-19T09:00:00Z" } },
    "deployment": { "status": "unknown", "evidence": { "status": "unknown", "timestamp": null } }
  },
  "aiJobs": [],
  "alerts": [],
  "workflows": [{ "id": "assess-test-status", "safetyLevel": "read-only" }],
  "evidence": { "status": "available", "timestamp": "2026-07-19T09:00:00Z" }
}
```

Die primäre Empfehlung ist `assess-test-status` mit Reason-Code
`TESTS_FAILED`. Build, Release und Deployment erscheinen unter
`missingEvidence`; sie werden nicht als Fehlschlag dargestellt.

## Beispiel ohne ausreichende Evidence

Wenn `quality.tests.status` zwar `failed` lautet, dessen Evidence aber
`unknown` oder `unavailable` ist, bleibt `recommendation` auf `null`.
`missingEvidence` nennt `quality.tests`, und der Router führt weiterhin nichts
aus.

## Sicherheitsgrenzen

- Modus ausnahmslos `observe`
- keine Workflow-, Provider-, Shell-, Datei-, Git-, PC- oder Netzwerkaktion
- keine automatische Vorbereitung oder Ausführung
- nur explizit übergebene, sichere Dashboard-Workflows
- feste Reason-Codes und feste kurze Texte statt generierter Begründungen
- Prompt-Injection-Text kann keine Regel, Allowlist oder Sicherheitsstufe ändern
- sichere Fehler ohne Stacktrace oder lokalen Dateipfad
- Logging nur von Projekt-ID, Vorhandensein einer Empfehlung, Reason-Code und
  Modus; keine Eingabeinhalte oder Evidence-Rohdaten

Die Recommendation Engine erteilt keine Freigabe und führt keinerlei
automatische Aktion aus.
