# AI-Router Routing-Core v2 und Cockpit-Kompatibilität

## Ziel und Architektur

Der Routing-Core ist die einzige fachliche Entscheidungsinstanz für freie
Router-Aufträge. Er kombiniert bestehende Komponenten statt einen zweiten
Router aufzubauen:

1. `router-contract.js` validiert und normalisiert den Request.
2. `routing-engine.js` klassifiziert Route, Aufgabenart, Komplexität und Risiko
   deterministisch.
3. `provider-selection.js` und `provider-registry.js` wählen ausschließlich aus
   den vorhandenen lokalen Providerprofilen.
4. `router-response.js` projiziert Empfehlung oder Simulation in Schema `2.0`.
5. `cockpit-router-adapter.js` übersetzt den bestehenden Cockpit-Mock-Vertrag
   ohne eigene Routingregeln in den Core und dessen Antwort zurück.

Der Router bleibt zustandslos. Es gibt keine Datenbank, Queue oder persistente
Job-Hülle für diesen Endpoint. Vorhandene historische Run-APIs sind getrennte
Legacy-Funktionen und werden vom Routing-Core nicht gestartet.

## Fachliche Trennung und Zustandsmodell

| Begriff | Aktueller Status | Bedeutung |
| --- | --- | --- |
| Empfehlung | aktiv | Deterministische Route und Providerprofil-Empfehlung, ohne Ablaufplan |
| Simulation | aktiv | Gleiche Empfehlung plus lokaler Mock-Ablaufplan |
| geplante Aktion | nur Metadatum | Schritt oder Fähigkeit, die später benötigt würde |
| freigabepflichtige Aktion | vorbereitet | `approvalWouldBeRequired` und `futureMode: approval_required`; nicht anforderbar |
| ausgeführte Aktion | deaktiviert | Kein Core-Pfad kann `execution` starten |
| abgelehnte Aktion | aktiv | `status: rejected`, wenn eine riskante Aktion erkannt wird |
| fehlgeschlagene Aktion | nicht vorhanden | Fehler betreffen ausschließlich Validierung/Routing; es wird keine Aktion gestartet |

Aktive Response-Statuswerte:

- `recommended`: Recommendation Request erfolgreich
- `simulated`: Simulation erfolgreich, `executed: false`
- `rejected`: sicherheitsrelevante Anfrage bewusst abgelehnt
- `failed`: Validierungs-, Routing- oder interner Fehler

Nur vorbereitete, nicht aktive Status-/Modusbegriffe:

- `approval_required`
- `execution`

Es gibt aktuell kein `approved`, `executing` oder `completed`, weil keine
Ausführung existiert.

## Kanonischer Endpoint

```text
POST /api/router/route
Content-Type: application/json
```

Maximaler Body: 16 KiB. Timeout: 5 Sekunden. Antworten und Fehler verwenden
dieselbe v2-Hülle. Der Endpoint speichert den Request nicht.

### Request-Schema

Das maschinenlesbare Schema liegt unter `schemas/router-request-v2.json`.

Pflichtfelder:

- `schemaVersion: "2.0"`
- `source`: mindestens `cockpit`, `api` oder `internal_test`
- `mode`: `recommendation` oder `simulation`
- `intent`: feste Intent-Allowlist, `auto` für die deterministische Erkennung
- `input.type: "text"` und begrenztes `input.content`

Optionale, strikt projizierte Felder:

- `requestId`, `correlationId`, ISO-Zeitstempel
- Kontexttyp und -größe, benötigte Aktualität, private Daten, Client
- erlaubte/verbotene Fähigkeiten, Risiko-, Datenschutz-, Kosten- und
  Latenzklasse
- begrenzte Dateiverarbeitung
- allowlistetes Providerprofil und Workflowprofil
- kleine technische Metadaten ohne freie verschachtelte Objekte

Unbekannte Felder werden abgelehnt. `allowActions: true`, widersprüchliche
Capabilities, unbekannte Capabilities, nicht erlaubte Provider und inaktive Modi
werden nicht still korrigiert.

### Vollständiger Cockpit-Request

```json
{
  "schemaVersion": "2.0",
  "requestId": "cockpit_req_20260719_001",
  "correlationId": "cockpit_session_42",
  "timestamp": "2026-07-19T10:00:00Z",
  "source": "cockpit",
  "mode": "simulation",
  "intent": "project_status_summary",
  "input": {
    "type": "text",
    "content": "Cockpit-Projektstatus zusammenfassen"
  },
  "context": {
    "project": "felix-cockpit",
    "contentType": "text",
    "contextSize": "small",
    "requiresFreshData": false,
    "containsPrivateData": false,
    "requiredTools": ["repository-read"],
    "client": "felix-cockpit"
  },
  "constraints": {
    "allowedCapabilities": ["analysis", "simulate", "recommendation.read"],
    "forbiddenCapabilities": ["execute", "file.write", "git.push", "shell.run"],
    "riskLevel": "low",
    "privacyLevel": "local-only",
    "costClass": "medium",
    "latencyClass": "medium",
    "allowFileProcessing": false
  },
  "options": {
    "allowActions": false
  },
  "metadata": {
    "clientVersion": "cockpit-adapter-1",
    "tags": ["mobile"]
  }
}
```

## Response-Schema

Das Schema liegt unter `schemas/router-response-v2.json`. Nutzerfreundliche
Felder stehen in `recommendation`; technische und sicherheitsrelevante Angaben
sind davon getrennt unter `simulation`, `risks`, `constraints`,
`blockedActions`, `error` und `meta`.

### Beispielantwort

```json
{
  "schemaVersion": "2.0",
  "requestId": "cockpit_req_20260719_001",
  "routerVersion": "0.13.0-test",
  "status": "simulated",
  "mode": "simulation",
  "recommendation": {
    "intent": "project_status_summary",
    "detectedIntent": "unknown",
    "taskType": "unknown",
    "complexity": "medium",
    "route": "cockpit_command",
    "title": "Sichere Router-Empfehlung",
    "summary": "Die Anfrage bezieht sich auf eine sichere Cockpit-Vorschau.",
    "reasonCodes": ["ROUTE_COCKPIT_COMMAND", "TASK_UNKNOWN", "DETERMINISTIC_PROVIDER_SELECTION"],
    "evidence": [
      { "field": "routing.taskType", "value": "unknown" },
      { "field": "routing.requiredCapabilities", "value": ["analysis"] },
      { "field": "routing.contextType", "value": "text" },
      { "field": "routing.freshnessRequired", "value": false }
    ],
    "confidence": 0.9,
    "recommendedProvider": {
      "providerId": "codex-local-readonly",
      "displayName": "Codex lokal read-only",
      "simulatedProfile": false,
      "externalCallAllowed": false
    },
    "mockFallback": {
      "providerId": "mock-local",
      "adapterId": "mock",
      "available": true,
      "executed": false
    }
  },
  "simulation": {
    "providerId": "mock-local",
    "adapterId": "mock",
    "providerWorkflowProfile": "single_provider",
    "plannedSteps": [],
    "requiredCapabilities": ["analysis"],
    "requiredTools": ["repository-read"],
    "allowedActions": ["result.display"],
    "blockedActions": ["execute", "file.write", "git.push", "shell.run"],
    "approvalWouldBeRequired": false,
    "futureMode": null,
    "expectedResultFormat": "structured-router-response-v2",
    "executionStatus": "never_executed",
    "executed": false
  },
  "risks": { "level": "low", "reasonCodes": ["NO_EXECUTION_PERMITTED"] },
  "constraints": {},
  "allowedNextSteps": ["result.display"],
  "blockedActions": ["execute", "file.write", "git.push", "shell.run"],
  "error": null,
  "meta": {
    "durationMs": 1,
    "timestamp": "2026-07-19T10:00:00Z",
    "stateModelVersion": "1.0",
    "executionEnabled": false
  }
}
```

Die verkürzten Arrays im Dokumentationsbeispiel illustrieren das Format; die
echte Antwort führt die vollständige zentrale Blocklist und die geplanten
Mock-Rollen auf.

## Deterministische Routing- und Providerfaktoren

Berücksichtigt werden vorhandene, feste Daten:

- Aufgabenart und Nutzerintent
- benötigte Capability
- Code-, Datei- und Bildkontext
- Kontextgröße
- benötigte Aktualität
- Datenschutz- und Risikogrenze
- Kosten- und Latenzklasse der Providerprofile
- Review-/Freigabebedarf

Providerprofile sind nur lokale Metadaten für Mock, Codex read-only, Claude,
OpenAI und Gemini. Claude/OpenAI/Gemini werden nicht aufgerufen. Benötigt eine
Anfrage echte aktuelle Daten, gibt es bewusst `NO_SAFE_ROUTE`, weil externe
Recherche deaktiviert ist. Datei- und Bildverarbeitung bleiben reine
Planungsfähigkeiten ohne Datei-Upload oder Dateizugriff.

Die Recommendation und die Simulation verwenden dieselbe Entscheidung. Die
Simulation ergänzt nur Rollen, benötigte Fähigkeiten, Risiken, erlaubte
Anzeige-Schritte, Blocklist und erwartetes Ergebnisformat. Tatsächlicher
Simulationsprovider ist immer `mock-local`.

## Cockpit-Iststand und Mapping

Das mobile Felix-Cockpit besitzt derzeit:

- `ai-router-adapter.js`: lokale Textmuster-Entscheidung `codex`/`mock`
- `api/ai-router-simulate.js`: authentifizierter 4-KiB-Mock-Endpoint mit
  20 Requests/Minute
- `router-status.js`: read-only GETs auf lokalen Router-Health-, Status- und
  Run-Endpunkten mit Größenlimit und Timeout
- `js/app.js`: lokale Fallbackanzeige, Request-Client und strikte
  Responsevalidierung

Cockpit-Request v1:

```json
{
  "schemaVersion": 1,
  "mode": "simulate",
  "execute": false,
  "type": "route.recommendation",
  "request": "Cockpit-Projektstatus zusammenfassen",
  "requestedCapability": "simulate"
}
```

`cockpit-router-adapter.js` übernimmt exakt dieses Format, erzeugt daraus einen
kanonischen v2-Request und projiziert die zentrale Antwort zurück auf die vom
Cockpit erwarteten Felder. Der Adapter enthält keine Textklassifikation oder
Providerentscheidung. Dadurch existiert im Router nur ein Simulationsformat;
Cockpit v1 ist eine begrenzte Transportkompatibilität.

Aktuelle Unterschiede:

- Cockpit verwendet Integer-Version `1`; Core verwendet String-Version `2.0`.
- Cockpit nennt den Modus `simulate`; Core nennt ihn `simulation`.
- Cockpit kennt nur einen Flachvertrag; Core trennt Empfehlung und Simulation.
- Cockpit klassifiziert derzeit lokal; nach Anbindung ist nur noch der Core
  autoritativ, der lokale Code bleibt reiner Offline-Fallback.
- Cockpit verwendet LocalStorage nur für Cockpit-API-URL und Read-Token
  (`fc_cockpit_api_url_v1`, `fc_cockpit_read_token_v1`). Simulationsergebnisse
  werden nicht dauerhaft gespeichert und nicht ins Backup aufgenommen.

Keine Cockpit-Datei muss für diese Vorbereitung geändert werden. Für die echte
Verbindung genügt später ein kleiner BFF-Patch: Der bestehende geschützte
`/api/ai-router-simulate`-Handler leitet nach Authentifizierung den v1-Request
an `/api/router/route` weiter oder erzeugt direkt v2. Der lokale
`simulateAiRouter`-Entscheider bleibt dann ausschließlich Offline-Fallback.

## Fehlercodes

- `INVALID_REQUEST`: Body ist kein Objekt oder JSON ist ungültig
- `UNSUPPORTED_SCHEMA_VERSION`: unbekannte Schema-Version
- `VALIDATION_FAILED`: Pflichtfeld, Format oder unbekanntes Feld ungültig
- `SOURCE_NOT_ALLOWED`: unbekannte Quelle
- `MODE_NOT_ALLOWED`: Modus ist nicht Recommendation/Simulation
- `CAPABILITY_NOT_ALLOWED`: gefährliche, unbekannte oder gesperrte Fähigkeit
- `CONFLICTING_CONSTRAINTS`: widersprüchliche Sicherheitsangaben
- `PROVIDER_NOT_ALLOWED` / `PROVIDER_NOT_FOUND`: Provider nicht freigegeben
- `NO_SAFE_ROUTE`: keine sichere lokale Route, beispielsweise bei benötigten
  Live-Daten
- `SIMULATION_FAILED`: sichere Projektion konnte intern nicht gebildet werden
- `INTERNAL_VALIDATION_FAILED` / `INTERNAL_ERROR`: generischer interner Fehler
- `PAYLOAD_TOO_LARGE`: Request überschreitet die Grenze
- `TIMEOUT`: fünf Sekunden überschritten

Fehler enthalten keine Stacktraces, lokalen Pfade, Secrets oder Provider-
Konfigurationen.

## CORS, Authentifizierung, Rate Limit und Fallback

Der lokale Router akzeptiert keine beliebigen Browser-Origin. Die bestehende
Origin-Allowlist bleibt auf lokale Cockpit-Adressen begrenzt. Der Core führt
keine neue Remote-Authentifizierung und kein neues Rate-Limit ein, weil keine
offene Produktivschnittstelle gebaut wird.

Für eine spätere mobile Verbindung bleibt der vorhandene Cockpit-BFF die
Sicherheitsgrenze: Bearer-Token, HTTPS-Prüfung, 4-KiB-Limit und 20 Requests pro
Minute gelten dort weiterhin. Bei Timeout, Netzfehler oder ungültigem Schema
bleibt die klar gekennzeichnete lokale Cockpit-Simulation der Fallback; sie
darf nie als echte Routerantwort erscheinen.

## Sicherheitsgrenzen und nicht unterstützte Funktionen

- keine produktive OpenAI-, Anthropic- oder Google-Anbindung
- keine Shell-, Datei-, Git-, E-Mail-, Kalender-, PC- oder Deployment-Aktion
- keine externe Recherche oder automatische Datenübertragung
- keine dauerhafte Jobverarbeitung
- keine automatische Freigabe
- keine Ausführung nach einer Simulation
- kein Request kann Blocklist, Provider-Allowlist oder `executionEnabled: false`
  überschreiben
- Logs enthalten nur Request-ID und begrenzte Entscheidungsmetadaten, niemals
  Aufgabeninhalt

`approval_required` und `execution` sind ausschließlich dokumentierte spätere
Integrationspunkte. Ihre Aktivierung benötigt einen neuen ausdrücklichen
Auftrag, Authentifizierung, persistente Freigabebindung und zusätzliche
Sicherheitsprüfungen.
