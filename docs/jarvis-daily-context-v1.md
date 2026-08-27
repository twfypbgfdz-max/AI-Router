# Jarvis-Tageskontext (P6-A) - Datenfluss-Dokumentation

Kurzdokumentation gemäß DEC-001 §4.3 für die neue Cockpit-Integration im
Knowledge-Pfad. Betrifft ausschließlich `POST /api/jarvis/ask`
(`orchestrator/jarvis-console-proxy.js`). Kein anderer Consumer des
Knowledge-Pfads (`/api/v1/knowledge`, `POST /api/v1/cc/knowledge`) ist
betroffen.

## Quelle

Felix Cockpit, `GET /api/cockpit-status`
(`felix-cockpit/api/cockpit-status.js`). Ausgelesen werden ausschließlich
die Sections `dailyState`, `tasks` und `calendar`. `training`, `github`,
`news` und `aiRouter` werden nie gelesen.

## Besitzer

Felix Cockpit. Es ist die alleinige Quelle für Tages- und Livedaten
(`operational_live`-Klasse in `orchestrator/knowledge-authority.js`).

## Leser

AI-Router / Jarvis, ausschließlich über:

- `orchestrator/cockpit-client.js` - read-only GET-Client
  (`AI_ROUTER_COCKPIT_BASE_URL`, `AI_ROUTER_COCKPIT_READ_TOKEN`).
- `orchestrator/jarvis-daily-intent.js` - deterministischer Tages-Intent-
  Matcher, kein Modellaufruf.
- `orchestrator/jarvis-daily-context.js` - Budgetierung (max. 3 Fokuspunkte,
  max. 8 Aufgaben, max. 5 Termine) und Aktualitätsbewertung.
- `orchestrator/knowledge-answer-prompt.js` (`buildOperationalContextBlock`)
  - rendert den Abschnitt `TAGESKONTEXT` im Prompt, getrennt vom
    CC-`AKTUELLER SYSTEMZUSTAND`-Block.

Wiring ausschließlich in `orchestrator/jarvis-console-proxy.js`. Von P6-A bis
2026-08-27 baute es **keine** eigene `createKnowledgeHandler`-Instanz,
sondern rief denselben exportierten Singleton (`handleKnowledgeRequest`) wie
`/api/v1/knowledge` in `server.js` auf, sodass sich beide Routen ein
einziges Rate-/Concurrency-Budget teilten. Realer Nutzungstest am
2026-08-27 zeigte, dass dieses geteilte 60s-Fenster für die menschliche
`/jarvis`-Konsole unnötig lang war. Seitdem baut die Datei eine **eigene**
`createKnowledgeHandler`-Instanz mit einem eigenen Budget
(`JARVIS_ASK_MAX_CONCURRENT_REQUESTS`/`JARVIS_ASK_MAX_REQUESTS_PER_WINDOW`/
`JARVIS_ASK_RATE_WINDOW_MS` in `orchestrator/knowledge-config.js`: weiterhin
eine gleichzeitige Anfrage, eine Anfrage pro Fenster, aber ein 5s- statt
60s-Fenster). `operationalContextProviderFn` wird dieser eigenen Instanz als
Konstruktor-Option mitgegeben. `/api/v1/knowledge`s eigener Singleton in
`server.js` ist davon unberührt und bleibt bei
`KNOWLEDGE_MAX_CONCURRENT_REQUESTS`/`KNOWLEDGE_MAX_REQUESTS_PER_WINDOW` und
dem festen 60s-Fenster - beide Routen können sich seitdem nicht mehr
gegenseitig throttlen. Der Cockpit-Aufruf erfolgt serverseitig und
ausschließlich dann, wenn `matchJarvisDailyIntent` die bereits validierte
Frage als Tagesfrage erkennt - nie aus einem User-Request-`context`-Feld.

## Schreibziele

Keine. Der gesamte Pfad ist read-only: kein Write auf Cockpit, kein Quick
Capture, keine Migration von Projekten/Blockern.

## Aktualitätsregel

- `dailyState`/`tasks`/`calendar` mit `status: "ok"` und `date` == heute
  (bzw. `stale: false`) gelten als frisch.
- Ein `date` ungleich heute oder `stale: true` wird als `"stale"` markiert
  und im Prompt ausdrücklich als veraltet gekennzeichnet
  (`operational_context_stale`-Warning in der Antwort).
- Ein erreichter, aber inhaltlich leerer Abschnitt (z. B. kein Fokus
  gesetzt) ist echter, aktueller Inhalt (`"empty"`), kein Fehler.

## Fehlerverhalten

Cockpit blockiert Jarvis nie vollständig:

- nicht konfiguriert, Timeout, Netzwerkfehler, falscher Content-Type,
  ungültiges JSON, zu große Antwort -> `state: "unavailable"` in
  `cockpit-client.js`, nie ein Wurf.
- Ein werfender oder hängender `operationalContextProviderFn` degradiert in
  `knowledge-handler.js` kontrolliert zu "kein Tageskontext" (try/catch),
  bricht die Knowledge-Antwort nie ab.
- Kommt insgesamt nichts Nutzbares zurück, bleibt `operationalContext` in
  `knowledge-service.js` `null` - der bestehende Fail-closed-Pfad
  (`no_context_no_knowledge`) greift dann unverändert, falls RAG ebenfalls
  keinen Treffer liefert. Es wird nie ein heutiger Stand erfunden.

## Konfliktregel

Für heutige operative Fakten (heutige Priorität, offene Aufgaben, heutige
Termine) ist ausschließlich `TAGESKONTEXT` maßgeblich. Keine Fundstelle aus
`LANGFRISTIGES SYSTEMWISSEN` (Vault-RAG) darf das überschreiben - fest
verankert in `OPERATIONAL_CONTEXT_RULE`
(`orchestrator/knowledge-answer-prompt.js`) und in der bereits bestehenden
Autoritäts-Zeile zu "Tages- und Livedaten" in `buildAuthorityBlock`.

## Löschregel

Es wird nichts persistiert. `operationalContext` existiert ausschließlich
für die Laufzeit einer einzelnen Anfrage und wird danach verworfen - kein
Cache, kein Log der Inhalte (nur `operational_context_stale` als Warning-
Code, nie der Klartext, im Server-Log).

## Vertragsgrenzen (unverändert)

- `/api/v1/knowledge` (`knowledge-contract.js`) und
  `POST /api/v1/cc/knowledge` (`cc-knowledge-contract.js`) bleiben exakt wie
  zuvor: kein neues Feld, kein Cockpit-Zugriff, `operationalContext` ist für
  beide immer `null` (Default-Provider `noOperationalContext` in
  `knowledge-handler.js`).
- `citedSources: []` bleibt für eine reine Operational-Antwort gültig - kein
  künstliches `K#` wird je erzeugt, da `allowedCitedSourceIds` weiterhin
  ausschließlich aus der Anzahl echter RAG-Treffer abgeleitet wird.
