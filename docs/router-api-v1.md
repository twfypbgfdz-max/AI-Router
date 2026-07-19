# Cockpit-Router-API v1

## Zweck und Sicherheitsgrenze

Die Cockpit-Router-API validiert und klassifiziert lokale Anfragen. Sie fuehrt
keine vorgeschlagene Aktion aus. Der Standardmodus ist `simulate`; `execute`
ist architektonisch sichtbar, wird aber immer mit `EXECUTION_DISABLED`
abgelehnt. Die neue API startet weder Provider noch Adapter und veraendert
keine externen Systeme.

## Architektur und Datenfluss

1. `orchestrator/server.js` nimmt die HTTP-Anfrage mit lokal begrenztem CORS,
   Bodylimit und einem bereits vor dem Body-Lesen gestarteten Timeout an.
2. `orchestrator/router-contract.js` validiert und normalisiert den Vertrag.
3. `orchestrator/routing-engine.js` bestimmt deterministisch Route, Konfidenz,
   Begruendung, Faehigkeiten, vorgeschlagene Aktion und Risiko.
4. `orchestrator/action-registry.js` prueft die vorgeschlagene Aktion gegen
   eine geschlossene Allowlist.
5. `orchestrator/router-response.js` baut das einheitliche Erfolgs- oder
   Fehlerformat.
6. `orchestrator/router-service.js` orchestriert nur diese Schritte und schreibt
   sichere Metadaten in das vorhandene JSONL-Logging. Anfrageinhalt, Secrets,
   Tokens und interne Pfade werden nicht geloggt.

Die bisherige Run-/Workflow-/Provider-Architektur bleibt getrennt und wird von
`POST /api/router/route` nicht aufgerufen.

## Eingabeformat

```json
{
  "schemaVersion": "1.0",
  "requestId": "req_example",
  "timestamp": "2026-07-19T10:00:00.000Z",
  "source": "cockpit",
  "mode": "simulate",
  "input": {
    "type": "text",
    "content": "Fasse meine heutigen Aufgaben zusammen."
  },
  "context": {
    "userId": "local-user",
    "sessionId": null,
    "project": null
  },
  "options": {
    "preferredProvider": null,
    "allowActions": false
  }
}
```

Pflichtfelder sind `schemaVersion`, `source`, `input.type` und
`input.content`. `schemaVersion` muss `"1.0"`, `input.type` muss `"text"` sein.
Ohne `requestId` erzeugt der Server eine ID mit dem Praefix `req_`; ohne
`timestamp` wird der aktuelle Zeitpunkt gesetzt. `mode`, `context` und
`options` erhalten sichere Standardwerte. Freie Providernamen oder Aktionen
werden nicht an andere Module weitergereicht.

Ein gelieferter Zeitstempel muss ein vollstaendiges ISO-8601-Date-Time mit
Zeitzone sein, beispielsweise `2026-07-19T10:00:00.000Z` oder
`2026-07-19T12:00:00+02:00`. Reine Datumswerte werden abgelehnt. Request-IDs
sind auf zentral konfigurierte 120 Zeichen begrenzt; normale und fehlerhafte
Anfragen verwenden dasselbe Limit.

## Ausgabeformat

```json
{
  "schemaVersion": "1.0",
  "requestId": "req_example",
  "status": "success",
  "mode": "simulate",
  "route": {
    "name": "task_management",
    "confidence": 0.92,
    "reason": "Die Anfrage bezieht sich auf Aufgaben oder Prioritaeten.",
    "requiredCapabilities": ["read_tasks"]
  },
  "decision": {
    "allowed": true,
    "action": "tasks.list",
    "riskLevel": "low",
    "requiresConfirmation": false
  },
  "result": {
    "executed": false,
    "summary": "Die Anfrage wuerde an task_management weitergeleitet; es wurde nichts ausgefuehrt.",
    "data": null
  },
  "error": null,
  "meta": {
    "durationMs": 1,
    "timestamp": "2026-07-19T10:00:00.000Z"
  }
}
```

Fehler verwenden dieselben neun Grundfelder. `status` ist dann `error`,
`result.executed` bleibt `false`, und `error` enthaelt einen stabilen Code,
eine bereinigte Meldung, `retryable` und optionale sichere Details.

Unerwartete interne Fehler verwenden immer eine generische oeffentliche
Meldung und keine Details. Stack-Traces, lokale Pfade, Moduldetails und
Credentials werden nicht an Clients ausgegeben. Erwartete Fehler duerfen nur
eine feste, rekursiv begrenzte Allowlist sicherer Detailfelder enthalten. Das
interne Metadaten-Logging ist von dieser oeffentlichen Fehlerprojektion
getrennt und speichert weder Fehler-Stacks noch vollstaendige Anfrageinhalte.

## Verfuegbare Routen

- `general_chat`
- `task_management`
- `project_management`
- `knowledge_query`
- `content_generation`
- `system_status`
- `cockpit_command`
- `unsupported`
- `blocked`

`unsupported` fuehrt zu `ROUTE_NOT_FOUND`. Riskante oder nicht freigegebene
Absichten werden als `blocked` erkannt und ohne Aktion erfolgreich als
blockierte Routing-Entscheidung zurueckgegeben.

## Aktions-Allowlist

In Simulationen registriert sind:

- `router.status`
- `router.explain`
- `tasks.list`
- `projects.list`
- `projects.status`
- `cockpit.preview`

Alle Registry-Eintraege haben `executionAllowed: false`. Nicht registrierte
Aktionen liefern `ACTION_NOT_ALLOWLISTED`. Insbesondere deaktiviert bleiben
Dateischreib- und Loeschoperationen, Git-Schreiboperationen, E-Mail-Versand,
Kalenderaenderungen, PC- oder Shell-Steuerung, Benutzerverwaltung und die
Ausgabe von Secrets oder Tokens.

## API-Endpunkte

### `POST /api/router/route`

Validiert und simuliert eine Routing-Entscheidung. Erfolg antwortet mit HTTP
200. Die zentrale Fehlerabbildung lautet:

- `INVALID_REQUEST`, `UNSUPPORTED_SCHEMA_VERSION` → HTTP 400
- `VALIDATION_FAILED`, `ROUTE_NOT_FOUND` → HTTP 422
- `ACTION_NOT_ALLOWLISTED`, `EXECUTION_DISABLED`, `ORIGIN_NOT_ALLOWED` → HTTP 403
- `PAYLOAD_TOO_LARGE` → HTTP 413
- `INTERNAL_ERROR` → HTTP 500
- `UNAVAILABLE` → HTTP 503
- `TIMEOUT` → HTTP 504

Das standardisierte Antwortformat bleibt bei jedem Statuscode erhalten.

### `GET /api/router/status`

Liefert Router-Version, Betriebsstatus, Schema-Versionen, Standardmodus,
Routen, Anzahl simulierbarer Aktionen und `executionEnabled: false`.

### `GET /api/router/actions`

Liefert nur die bereinigten Registry-Felder. Secrets und interne Systempfade
sind nicht Bestandteil des Vertrags.

## Fehlercodes

Die neue API verwendet insbesondere `INVALID_REQUEST`,
`UNSUPPORTED_SCHEMA_VERSION`, `VALIDATION_FAILED`, `ROUTE_NOT_FOUND`,
`ACTION_NOT_ALLOWLISTED`, `EXECUTION_DISABLED`, `INTERNAL_ERROR`, `TIMEOUT` und
`UNAVAILABLE`. Bestehende Fehlercodes der Run- und Provider-APIs bleiben
weiterhin gueltig.

## Lokaler Start und Tests

```text
npm start
npm test
node --test test/router-foundation.test.js test/router-api.test.js
```

Der Server bindet nur an `127.0.0.1:8787`. CORS wird ausschliesslich fuer
`/api/router/*` gesetzt und akzeptiert nur diese zentral konfigurierten Origins:

- `http://127.0.0.1:8787`
- `http://127.0.0.1:3000`
- `http://localhost:3000`

Andere Ports, fremde lokale Hosts und externe Origins werden abgelehnt.
Origin-lose Requests bleiben fuer bewusste lokale CLI-/Server-Kommunikation
zulaessig. Diese Router-Allowlist erweitert nicht die bestehende engere
Mutation-Regel: alte Schreibendpunkte akzeptieren weiterhin nur origin-lose
lokale Requests oder exakt `http://127.0.0.1:8787` und erhalten keine neuen
CORS-Header.

Der Router-Request-Body ist auf 16 KiB begrenzt. Der Fuenf-Sekunden-Timeout
beginnt vor dem Body-Lesen, umfasst daher auch langsame Uploads und antwortet
mit HTTP 504. Sobald eine gueltige Request-ID aus dem vollstaendigen Body
identifiziert wurde, bleibt sie in einer spaeteren Timeout-Antwort erhalten;
`durationMs` bildet die tatsaechlich verstrichene Zeit ab.

`npm test` startet die Suite mit einem eigenen temporaeren Runtime-Datenordner
und entfernt ihn danach. Die echten Dateien unter `.ai-router-data` werden von
der Testsuite nicht geschrieben oder rotiert.
