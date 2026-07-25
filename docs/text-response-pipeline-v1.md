# Read-only provider response pipeline v1

## Zweck und Abgrenzung

`POST /api/router/respond` beantwortet allgemeine Textfragen und Fragen zu
Felix' internem System, wenn der benötigte Systemkontext ausdrücklich im
Request als Text mitgesendet wird. Der Endpunkt beschafft niemals selbst
Kontext aus Dateien, Repositories, Git, Obsidian, E-Mails, Kalendern, URLs oder
anderen Systemen.

`POST /api/router/route` bleibt der deterministische Recommendation- und
Simulations-Endpunkt ohne externen Provideraufruf. `/respond` ist eine separate
Pipeline und verwendet weder `RunService`, `workflow-engine`, `codex-adapter`,
Codex-CLI, Approval-Flows, Run Stores noch Shell-, Git- oder Dateizugriffe.
Cockpit und Command Center werden durch diesen Meilenstein nicht umgebaut.

Der Datenfluss ist:

```text
POST /api/router/respond
-> Transportprüfung
-> interne Bearer-Authentifizierung
-> Instanz-lokales Rate- und Parallelitätslimit
-> strikte Requestvalidierung
-> gemeinsame, rein deterministische Aufgabenklassifikation
-> zentrale Privacy-/Security-/Egress-Policy
-> Zeichen-, Token- und Kostenbegrenzung
-> serverseitig konfigurierter OpenAI-Textadapter
-> genau ein nicht-streamender Responses-API-Aufruf
-> Text-, Struktur-, Token- und Ausgabelimitprüfung
-> sichere JSON-Antworthülle
```

## Providergrenze

Version 1 besitzt genau einen echten Adapter: `openai-text-v1`. Er verwendet
ausschließlich den festen offiziellen Endpunkt
`https://api.openai.com/v1/responses`, natives Node-`fetch`, `store: false`,
`max_output_tokens: 800` und ein verpflichtendes `AbortSignal`.

Der Providerrequest enthält kein `tools`, `functions`, `function_call`,
`stream`, `previous_response_id`, keine frei wählbare Base-URL und keinen
Client-Modellwert. Es gibt keinen Retry, keinen Fallback, keinen zweiten
Provider und keine rekursive Korrekturanfrage. OpenAI empfiehlt für neue
Textgenerierungsanwendungen die Responses API und dokumentiert die Trennung
zwischen höher priorisierten `instructions` und Nutzereingaben:

- https://developers.openai.com/api/docs/guides/text
- https://developers.openai.com/api/docs/models

Das Modell wird ausschließlich mit `AI_ROUTER_OPENAI_MODEL` serverseitig
gesetzt. Es gibt bewusst keinen Modell-Default. Der öffentliche Response nennt
nur `server-configured`; Logs verwenden ausschließlich den Alias
`configured-openai-text`.

## Authentifizierung

Der erwartete Header ist:

```http
Authorization: Bearer <AI_ROUTER_INTERNAL_TOKEN>
```

`AI_ROUTER_INTERNAL_TOKEN` muss serverseitig gesetzt sein und mindestens 32
Zeichen besitzen. Der Vergleich erfolgt über gleich lange SHA-256-Digests mit
`crypto.timingSafeEqual`. Im Rate-Limiter wird nur ein gekürzter
Token-Fingerprint gespeichert, niemals der Klartexttoken. Fehlende
Serverkonfiguration, fehlender Header und falscher Token liefern getrennte,
stabile Fehlercodes, aber keine Token- oder Konfigurationsdetails.

Browser-Origin-Requests sind für `/respond` gesperrt. Der vorgesehene Weg ist
`Cockpit-BFF -> AI-Router`, nicht Browser -> AI-Router. `/route` und `/status`
behalten ihr bestehendes Verhalten.

## Requestvertrag

Erlaubte Sources sind ausschließlich `cockpit` und `internal_test`.
Unbekannte Felder werden auf jeder Ebene abgelehnt. Provider, Modell, URL,
Host, Tools oder Capabilities können nicht über den Clientvertrag gesetzt
werden. Eine URL oder ein Dateipfad innerhalb des normalen Textes bleibt nur
Text und löst keinen Zugriff aus.

Allgemeine Frage:

```json
{
  "schemaVersion": "1.0",
  "requestId": "req_example_general",
  "source": "cockpit",
  "intent": "auto",
  "input": {
    "type": "text",
    "content": "Erkläre deterministisches Routing in drei Absätzen."
  }
}
```

Frage mit ausdrücklich übermitteltem Systemkontext:

```json
{
  "schemaVersion": "1.0",
  "requestId": "req_example_context",
  "source": "cockpit",
  "intent": "project_status_summary",
  "input": {
    "type": "text",
    "content": "Wie ist der übermittelte Stand des AI-Routers?"
  },
  "context": {
    "type": "text",
    "content": "Der AI-Router wurde zuletzt auf einem freigegebenen Teststand geprüft.",
    "containsPrivateData": false,
    "privacyLevel": "external-provider-allowed",
    "sourceLabel": "cockpit-project-status",
    "capturedAt": "2026-07-25T12:00:00.000Z"
  }
}
```

Sobald `context` vorhanden ist, sind `containsPrivateData`, `privacyLevel`,
`sourceLabel` und `capturedAt` Pflicht. Für Provider-Egress ist in v1 nur
`external-provider-allowed` zulässig. `containsPrivateData: true`,
`local-only`, fehlende oder unbekannte Privacy-Klassifikation und erkannte
Secret-/Credential-Muster blockieren vor Adaptererzeugung und Provideraufruf.

## Systemfragen und Untrusted Text

Die feste serverseitige Instruktion trennt Nutzerfrage und optionalen Kontext
technisch vom höher priorisierten Regeltext. Sie verbietet insbesondere:

- erfundene aktuelle interne Zustände, Commits, Tests, Dateien und Entscheidungen
- behaupteten Datei-, Git-, E-Mail-, Kalender-, URL- oder Deploymentzugriff
- Aktionen, Tool-Calling, Agents, Workflows und Offenlegung interner Prompts
- das Befolgen von Instruktionen innerhalb des untrusted Nutzer- oder Kontexttexts

Ohne ausreichenden übermittelten Kontext muss das Modell transparent sagen,
dass der aktuelle interne Stand nicht bereitgestellt wurde. Der Router selbst
liest nichts nach. Providerantworten bleiben untrusted Klartext. Selbst Text
wie `git push`, `send email` oder `deploy now` löst keinen weiteren Codepfad
aus. Strukturierte Tool-, Function-, Computer- oder Action-Ausgaben des
Providers werden vollständig verworfen.

## Limits

| Grenze | Wert |
| --- | ---: |
| HTTP-Body | 16 KiB |
| Nutzerfrage | 8.000 Zeichen |
| Kontext | 4.000 Zeichen |
| Frage + Kontext | 12.000 Zeichen |
| geschätzter Input | 4.000 Tokens |
| Provideroutput | 800 Tokens |
| Provideroutput zusätzlich | 8.000 Zeichen |
| Gesamtbudget | 4.800 Tokens |
| Worst-Case-Kosten | höchstens 0,02 USD |
| Provider-Timeout | 15 Sekunden |
| Router-Gesamttimeout | 20 Sekunden |
| Rate Limit | höchstens 10 Requests/Minute/Token-Fingerprint |
| Parallelität | höchstens 2 laufende Requests/Instanz |

Die Tokenabschätzung ist deterministisch und konservativ: UTF-8-Bytes werden
durch drei geteilt und aufgerundet; feste Nachrichten-Overheads und die
serverseitige Instruktion zählen zum Input.

## Kostenkonfiguration

Live-Aufrufe bleiben fail-closed, bis alle folgenden Werte serverseitig gesetzt
sind:

```text
OPENAI_API_KEY
AI_ROUTER_OPENAI_MODEL
AI_ROUTER_INTERNAL_TOKEN
AI_ROUTER_OPENAI_INPUT_USD_PER_MILLION_TOKENS
AI_ROUTER_OPENAI_OUTPUT_USD_PER_MILLION_TOKENS
AI_ROUTER_MAX_COST_USD
```

Die beiden Preisvariablen müssen vor dem Rollout anhand der aktuellen
offiziellen Modellseite gesetzt und bei Modell- oder Preisänderungen erneut
geprüft werden. Der Router enthält bewusst keine erfundene oder still veraltete
Preistabelle. `AI_ROUTER_MAX_COST_USD` muss positiv und darf niemals größer als
`0.02` sein. Fehlt eine Preisangabe, ist sie ungültig oder überschreitet die
Worst-Case-Berechnung das Limit, findet kein Providerrequest statt.

Optionale Schutzkonfiguration:

```text
AI_ROUTER_PROVIDER_TIMEOUT_MS=15000
AI_ROUTER_MAX_REQUESTS_PER_MINUTE=10
AI_ROUTER_MAX_CONCURRENT_REQUESTS=2
```

Höhere Werte als die sicheren Maxima werden nicht akzeptiert. `.env.example`
enthält ausschließlich Platzhalter; das Projekt lädt `.env`-Dateien nicht
automatisch.

## Timeout- und Abort-Kette

Der Abortpfad läuft durch:

```text
HTTP-Request
-> text-response-handler
-> text-response-service
-> openai-text adapter
-> fetch
```

Provider-Timeout, 20-Sekunden-Gesamttimeout, Client-Disconnect und ein
Server-Abbruch abortieren denselben echten Fetch-Pfad. Ein Promise-Race allein
ersetzt den Abort nicht. Der spätere Cockpit-BFF muss ein größeres Timeout als
der Router besitzen; mindestens 25 Sekunden plus Netzpuffer sind vorgesehen.

## Responsevertrag

Erfolg:

```json
{
  "schemaVersion": "1.0",
  "requestId": "req_example_general",
  "status": "answered",
  "route": {
    "name": "knowledge_query",
    "taskType": "learning"
  },
  "answer": {
    "type": "text",
    "text": "Deterministisches Routing ...",
    "trust": "untrusted_provider_text",
    "truncated": false
  },
  "provider": {
    "providerId": "openai-text-v1",
    "model": "server-configured"
  },
  "error": null,
  "meta": {
    "durationMs": 842,
    "toolCallingAllowed": false,
    "actionsExecuted": false,
    "inputTokenEstimate": 310,
    "providerInputTokens": 295,
    "providerOutputTokens": 120,
    "providerTotalTokens": 415,
    "worstCaseCostUsd": 0.00511,
    "calculatedCostUsd": 0.001015
  }
}
```

Fehler enthalten ausschließlich einen stabilen Code, eine generische
öffentliche Nachricht, optional einen festen Reason Code und `retryable`.
Providerrohbody, Prompt, Nutzerfrage, Kontext, Header und Secrets erscheinen
nicht im Response.

## Logging

Der neue Pfad verwendet einen eigenen Allowlist-Metadatenlogger ohne Datei-
oder Legacy-Run-Abhängigkeit. Er akzeptiert nur primitive, fest benannte Werte:
Request-ID, Source, Route, Tasktyp, Provider-ID, interner Modellalias, Dauer,
Status/Fehlercode, numerische Token-/Kostenmetadaten, Abortgrund und
Rate-Limit-Entscheidung.

Nutzerfrage, Kontext, Systeminstruktion, Providerrequest, Providerantwort,
Authorization-Header, API-Key, Service-Token und Providerrohfehler werden
niemals an den Logger übergeben.

## Lokale Tests

```bash
npm test
node --test test/text-response-smoke.test.js
```

Die Tests verwenden ausschließlich Dependency Injection und Fake-Adapter.
Automatisierte Tests und Smoke-Tests führen keinen echten OpenAI-Aufruf aus.

## Bekannte Production-Grenze

Rate- und Parallelitätslimits sind absichtlich In-Memory und gelten nur pro
laufender Instanz. Bei mehreren serverlosen Instanzen sind sie keine globale
Garantie. Vor einem Production-Rollout muss dafür ein zentraler, atomarer
Limiter mit gleicher fail-closed Semantik ergänzt werden. Dieser Meilenstein
enthält keinen Deployment- oder Cockpit-Umbau.
