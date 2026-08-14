# AI Router

Lokale HTML-Test-App zur einfachen Empfehlung eines passenden KI-Tools fuer eine Aufgabe.

## Version

Aktuelle Testversion: `v0.13.0-test`

## Cockpit-Routing-Core v2

`POST /api/router/route` ist der kanonische, zustandslose Routing-Kern. Schema
`2.0` unterstuetzt aktiv nur `recommendation` und `simulation`. Die Antwort
trennt Empfehlung, Providerprofil, Evidence, Risiken, Constraints und einen
rein lokalen Mock-Simulationsplan. `approval_required` und `execution` sind nur
als spaetere Zustandsnamen dokumentiert und werden als Request-Modus abgelehnt.

### Vercel-Preview

Die Handler `api/router/route.js` und `api/router/status.js` stellen ausschließlich
den zustandslosen Routing-Core und seinen read-only Status als Vercel Functions
bereit. Sie starten keinen dauerhaften Listener, verwenden keinen Run-Store und
loggen keine Requesttexte. Browser-Origin bleiben auf der bestehenden lokalen
Allowlist; der vorgesehene externe Zugriff erfolgt serverseitig über den
geschützten Felix-Cockpit-BFF. Provider-APIs und Ausführung bleiben deaktiviert.

Die bestehende Felix-Cockpit-Simulation (`schemaVersion: 1`, `mode: simulate`)
wird durch einen schmalen Kompatibilitaetsadapter in denselben Core uebersetzt.
Der Adapter besitzt keine eigene Routinglogik. Damit bleibt genau eine
Provider- und Routingentscheidung autoritativ. Es gibt keine echte
Provider-Anbindung, keine Action-Ausfuehrung und keine persistente Job-Queue.

`GET /api/router/status` und `GET /api/router/actions` stellen sichere Betriebs-
und Allowlist-Metadaten bereit. Router-CORS bleibt auf die feste lokale
Cockpit-Origin-Allowlist begrenzt. Architektur, Statusmodell, Vertraege,
Cockpit-Mapping, Beispiele und Fehlercodes stehen in
[`docs/router-core-v2.md`](docs/router-core-v2.md). Die fruehere v1-Dokumentation
bleibt nur als historische Vertragsbeschreibung erhalten.

## Sichere Read-only-Textantworten

`POST /api/router/respond` ist ein separater, intern authentifizierter
Textantwort-Endpunkt. Er verwendet genau einen serverseitig konfigurierten
OpenAI-Textadapter und genau einen nicht-streamenden Providerrequest. Es gibt
keine Tools, Functions, Agents, Workflows, Aktionen, Retries, Fallbacks oder
automatische Kontextbeschaffung.

Allgemeine Fragen benötigen keinen Kontext. Fragen zum aktuellen Stand von
Felix' internem System dürfen nur den ausdrücklich im Request übermittelten,
als `external-provider-allowed` klassifizierten Textkontext verwenden. Ohne
ausreichenden Kontext muss fehlende Aktualität transparent benannt werden.
Private, lokale, unklassifizierte, Secret-artige oder eindeutig operative
Requests werden vor jedem Provideraufruf blockiert.

Der vorgesehene Zugriff ist `Cockpit-BFF -> AI-Router` mit
`Authorization: Bearer <AI_ROUTER_INTERNAL_TOKEN>`. Der Browser greift nicht
direkt auf `/respond` zu. Limits, Umgebungsvariablen, Request-/Responsebeispiele,
Timeout-/Abort-Kette, Loggingregeln und bekannte Production-Grenzen stehen in
[`docs/text-response-pipeline-v1.md`](docs/text-response-pipeline-v1.md).
`POST /api/router/route` und die bestehende Cockpit-Simulation bleiben davon
getrennt und rufen weiterhin keinen externen Provider auf.

## Command-Center-Statuskontrakt (v1)

`GET /api/v1/cc/status` ist ein separater, intern authentifizierter, rein
lesender Statuskontrakt ausschliesslich fuer das Felix Command Center. Seine
`schemaVersion "1.0"` ist ein eigener, unabhaengiger Zaehler und darf nie mit
der Router-`schemaVersion "2.0"` verglichen oder synchron gehalten werden —
es sind zwei getrennte Vertraege.

Der Endpunkt fuehrt keine neue Providerpruefung durch und liest ausschliesslich
den bereits vorhandenen, synchronen Provider-Registry-Zustand. `routerStatus`
(`ok`/`degraded`) beschreibt nur die Integritaet der Provider-Registry und ist
nicht identisch mit `serviceStatus` aus `/api/router/status` oder
`/api/health`. `providers[].status` kennt kein `degraded` — nur
`available`/`unavailable`/`unknown`/`invalid`. `checkedAt` ist aktuell immer
`null` und traegt keine Freshness-Garantie. Nutzungs-/Kontingentdaten
(`usage`) sind in v1 immer explizit als nicht verfuegbar gekennzeichnet, nie
als `0` — es gibt aktuell keine reale Quelle fuer Provider- oder
Account-Limits.

Zugriff erfolgt ueber `Authorization: Bearer <AI_ROUTER_CC_TOKEN>` (eigenes,
von `AI_ROUTER_INTERNAL_TOKEN` getrenntes Secret), server-zu-server, ohne
Browser-Origin. Schema: [`schemas/cc-status-response-v1.json`](schemas/cc-status-response-v1.json).

## Command-Center-Statuszusammenfassung (v1)

`POST /api/v1/cc/summary` ist ein separater, intern authentifizierter
Endpunkt ausschliesslich fuer das Felix Command Center. Er baut aus dem
uebermittelten Projekt-/Service-Kontext einen Prompt und beantwortet ihn ueber
dieselbe read-only Text-Response-Pipeline wie `/api/router/respond`, dabei
aber fest auf den lokalen Ollama-Provider und den Intent
`project_status_summary` gezwungen (`AI_ROUTER_TEXT_PROVIDER` wird fuer diesen
Endpunkt intern ueberschrieben, unabhaengig von der globalen Konfiguration).
Authentifizierung wie bei `/api/v1/cc/status`:
`Authorization: Bearer <AI_ROUTER_CC_TOKEN>`.

`state` ist ein geschlossenes Enum mit genau diesen Werten:

- `ok` — Ollama erreichbar, Modell verfuegbar, Antwort erfolgreich erzeugt
  und unter dem eigenen Sichtbarkeits-Limit (2 KiB); `summary`, `provider`
  (immer `"ollama"`) und `model` sind gesetzt.
- `not_connected` — Ollama-Provider ist nicht konfiguriert oder nicht
  erreichbar (Netzwerkfehler, Verbindung verweigert).
- `model_missing` — Ollama laeuft, aber das konfigurierte Antwortmodell ist
  dort nicht vorhanden.
- `timeout` — die Provideranfrage hat die eigene absolute Zeitgrenze
  ueberschritten.
- `invalid_response` — Ollama hat geantwortet, aber die Antwort erfuellt die
  strikten Formatvorgaben der Pipeline nicht (kein reiner Text, unerwartete
  Struktur, ungueltige Nutzungsdaten o. ae.).
- `input_rejected` — der eingehende Request selbst ist ungueltig
  (falscher Content-Type, Schema-Verstoss, Sicherheitsblock, zu gross); dies
  ist der einzige Fall mit gesetztem `reason`.
- `response_too_large` — die erzeugte Antwort ist zwar gueltig, ueberschreitet
  aber das endpoint-eigene 2-KiB-Sichtbarkeitslimit und wird deshalb
  verworfen statt teilweise ausgeliefert.
- `temporarily_unavailable` — die geteilte Pipeline hat den Request wegen
  Kapazitaetsgrenzen abgelehnt (Rate- oder Concurrency-Limit dieses
  Endpunkts, unabhaengig von `/api/router/respond` gezaehlt), keine
  Provider-, Modell- oder Formatstoerung. Eingefuehrt, um diesen Fall von
  `invalid_response` zu unterscheiden, da er keinen echten Fehler darstellt,
  sondern eine erwartbare, kurzfristige Ueberlastsituation.

`retryAfterSeconds` ist bei jedem anderen Zustand `null` und wird nur bei
`temporarily_unavailable` gesetzt — und auch dort ausschliesslich, wenn die
geteilte Pipeline selbst einen `Retry-After`-Header liefert (Rate-Limit-Fall);
beim Concurrency-Limit bleibt er `null`, da die Pipeline dafuer keinen
eigenen Wert liefert und keiner geschaetzt wird. Ein gesetzter Wert ist
immer eine ganze Zahl zwischen 1 und dem festen Zeitfenster des Limiters
(aktuell 60 Sekunden) — alles ausserhalb wird verworfen statt geraten.

## Evidence-basierte Workflow-Empfehlungen

`POST /api/router/recommendations` wertet normalisierte, belegte Statusdaten
deterministisch aus. Die Schnittstelle bleibt immer im Modus `observe`, nutzt
ausschliesslich die im Input enthaltene Dashboard-Workflow-Allowlist und kann
nur `read-only` oder `prepare-only` empfehlen. Sie startet keinen Workflow,
keinen Provider und keinen Prozess, schreibt keine Datei und erzeugt kein
Aktionsobjekt. Ungueltige oder zukuenftige Evidence wird als `unavailable`
behandelt; `unknown` wird nicht als Fehler interpretiert.

Vertraege, Prioritaeten, Sicherheitsgrenzen und Beispiele stehen in
[`docs/recommendation-engine-v1.md`](docs/recommendation-engine-v1.md).

## Command-Center-Snapshot und deterministisches Ranking (v1)

`POST /api/v1/cc/snapshot` ist ein separater, intern authentifizierter,
ausschliesslich eingehender Endpunkt fuer das Felix Command Center. Der
Router erhebt hier keine eigenen Rohdaten (kein Git, keine Dateiscans, keine
Alert-Quellen) — jedes Feld kommt ausschliesslich aus dem uebermittelten
Snapshot-Payload. Eingehende Snapshots werden ausschliesslich in-memory pro
Request verarbeitet; es gibt keine Persistenz, kein Schreiben nach
`.ai-router-data/` oder anderswo fuer diesen Endpunkt.

**Verhaeltnis zur Recommendation Engine:** `POST /api/router/recommendations`
und `cc/snapshot` sind zwei bewusst getrennte, nicht austauschbare
Priorisierungssysteme fuer unterschiedliche Fragestellungen. Die
Recommendation Engine beantwortet „welcher einzelne, erlaubte Workflow ist
jetzt der richtige naechste Schritt?“ ueber eine geordnete Regelkaskade
(erste zutreffende Regel gewinnt). `cc/snapshot` beantwortet „wie sind
mehrere gleichzeitig gemeldete, heterogene Zustaende (Alerts, Services, Git,
Checks, Fortschritt) relativ zueinander zu ordnen?“ ueber ein additives
Scoring (Dringlichkeit × Auswirkung). Keines der beiden Systeme ruft das
andere auf, keines ersetzt das andere.

**Authentifizierung:** `Authorization: Bearer <AI_ROUTER_CC_TOKEN>` — dasselbe
Secret wie `/api/v1/cc/status`, `/api/v1/cc/summary` und `/api/v1/cc/knowledge`.
Mit `cc/snapshot` steuert dasselbe Secret erstmals nicht nur Lesezugriff,
sondern die Dateneingabe, aus der Priorisierung und Handlungsempfehlung
direkt berechnet werden. Ein kompromittiertes Token erlaubt damit nicht nur
Datenzugriff, sondern die gezielte Manipulation der Entscheidungsgrundlage
(z. B. vorgetaeuschte kritische Alerts, um eine bestimmte
Handlungsempfehlung zu erzwingen) — das ist bei der Token-Aufbewahrung
entsprechend hoeher zu gewichten als bei den bisherigen drei Endpunkten.

**Fuenf Datenbereiche** (`sections.alerts`, `.services`, `.gitRepositories`,
`.failedChecks`, `.projectProgress`), jeder mit derselben dreiwertigen
Codierung: ein komplett ausgelassener Bereich gilt als *nicht geliefert*
(`evidence.status: "unavailable"`); ein gelieferter, aber leerer Bereich hat
`evidence.status: "available"` mit gueltigem Zeitstempel und `items: []`; ein
veralteter Bereich traegt zusaetzlich `freshness: "stale"` (von Command
Center selbst gesetzt, der Router berechnet Staleness nicht selbst). Kein
Wert wird geraten, kein `0` dient als Platzhalter fuer „nicht verfuegbar“.

**Deterministisches Ranking:** `priorityScore = urgencyScore × impactScore`,
beides aus festen, im Code hinterlegten Mapping-Tabellen (nie pro Instanz
erraten). Items ohne belegte Evidence oder mit nicht handlungsrelevantem
Status (z. B. Alert-Status `unknown`, Service `ok`, Git `clean`) werden nicht
mit Score `0` gefuehrt, sondern aus dem Ranking ausgeschlossen und mit
Begruendungscode in `ranking.unranked` aufgefuehrt.

*Sonderregel `failedChecks.severity: "unknown"`:* anders als bei den vier
uebrigen Bereichen wird dieser Fall **nicht** ausgeschlossen, sondern mit
demselben Score wie `"non-blocking"` (=1) gefuehrt. Grund: Ein Eintrag in
`failedChecks.items` ist per Vertrag bereits ein belegter Fehlschlag
(`evidence.status: "available"` fuer den Fehlschlag selbst) —
`severity: "unknown"` betrifft ausschliesslich die Schwereklassifikation,
nicht die Existenz des Problems. Das unterscheidet sich kategorial von
`status: "unknown"` bei den anderen vier Bereichen, wo unbekannt bleibt, ob
ueberhaupt ein Attention-wuerdiger Zustand vorliegt.

**Ollama-Rolle — strikt begrenzt:** Ollama erhaelt ausschliesslich die
bereits fertige, geordnete `ranking.items`-Liste (inklusive der echten
`itemId` jedes Eintrags) und darf sie nur zusammenfassen und erklaeren. Das
Feld `narrative.recommendedItemId` in der Antwort ist immer die echte
`itemId` eines Eintrags aus `ranking.items` (oder `null`, wenn nichts
gerankt wurde) — niemals ein Positionslabel wie „R1“ und niemals eine freie
oder im Ranking nicht vorhandene ID. Der Wert wird ausschliesslich vom
Router selbst aus dem bereits feststehenden Top-Item abgeleitet — niemals
aus der Modellantwort uebernommen. Die Modellantwort dient nur als
Konsistenzpruefung: Bestaetigt sie nicht exakt dieselbe `itemId` (oder
`null`, wenn nichts gerankt wurde), gilt `narrative.state: "invalid_response"`
und die Rangliste selbst (`ranking`) bleibt davon unberuehrt und weiterhin
vollstaendig nutzbar — sie haengt nie von Ollamas Verfuegbarkeit ab.

`narrative.state` kennt `ok`, `not_connected`, `model_missing`, `timeout`,
`invalid_response`, `temporarily_unavailable` — dieselbe Bedeutung wie bei
`/api/v1/cc/summary`. `retryAfterSeconds` ist nur bei
`temporarily_unavailable` gesetzt und nur, wenn die geteilte Pipeline selbst
einen `Retry-After`-Header liefert.

**Knowledge-Treffer:** `knowledgeHits` wird nur befuellt, wenn `knowledgeQuery`
gesetzt ist, nutzt denselben RAG-Dienst und exakt dasselbe `source`-Schema
wie `/api/v1/cc/knowledge` (max. 3 Treffer, keine unbegrenzte Textmasse).

**Eigene, unabhaengige `schemaVersion "1.0"`** — wie bei jedem anderen
Command-Center-Vertrag ein separater Zaehler, nie mit `cc/status`,
`cc/summary`, `cc/knowledge` oder der Router-`schemaVersion "2.0"`
verglichen oder synchron gehalten.

## Lokaler FELIX_SYSTEM-Wissensindex (Commit B)

`orchestrator/knowledge/` baut einen lokalen Embedding-Index über explizit
freigegebene Markdown-Dokumente aus dem FELIX_SYSTEM-Obsidian-Vault auf.
Seit Commit C2b wird dieser Index über `POST /api/v1/cc/knowledge` (siehe
unten) für Antworten genutzt — weiterhin **nicht** über `/api/router/respond`
oder `/api/v1/cc/summary`.

- **Read-only gegenüber dem Vault:** Der gesamte Modul-Namespace öffnet
  ausschließlich die konkreten, in `config/rag-allowlist.json` freigegebenen
  Dateien. Es gibt keinen rekursiven Verzeichnis-Scan und keinen
  Schreib-/Lösch-/Umbenennungs-Zugriff auf `AI_ROUTER_VAULT_ROOT`.
- **Allowlist (Stand 11.08.2026): 10 freigegebene Dokumente.**
  `config/rag-allowlist.json` listet ausschließlich einzeln von Felix
  freigegebene Dateien (`addedBy`/`addedAt` je Eintrag): DEC-001, DEC-002,
  DEC-003, `00_System/FELIX_SYSTEM_Architektur_Index.md`,
  `10_Apps/01_Aktive-Projekte/AI-Router.md`,
  `10_Apps/01_Aktive-Projekte/Felix-Command-Center.md`, `90_System/Profil.md`
  (Personal-Context-Grundstand), `10_Apps/00_Projektsteuerung.md`,
  `10_Apps/90_Entscheidungen/DEC-006-Felix-Core-Vertragsebene.md` und
  `90_System/KI-Router-Regeln.md`. DEC-006 ist damit enthalten; DEC-004 und
  DEC-005 sind weiterhin nicht freigegeben. Jede weitere Datei erfordert
  einen eigenen, ausdrücklichen Auftrag; die Liste wächst nicht automatisch
  mit dem Vault.
- **Harte Denylist**, unabhängig vom Frontmatter-Typ und nicht durch die
  Allowlist überstimmbar: `60_Finanzen/`, `00_Inbox/`, `.obsidian/`,
  `.claudian/`, `.git/`, `.claude/` (siehe `orchestrator/knowledge/rag-config.js`).
- **Embedding-Modell:** `AI_ROUTER_OLLAMA_EMBEDDING_MODEL` (vorgesehen:
  `bge-m3:latest` — Ollama normalisiert einen Pull ohne Tag auf `:latest`,
  der Availability-Check vergleicht exakt), getrennt von
  `AI_ROUTER_OLLAMA_MODEL` (Antwortmodell). Kein automatischer Modell-Pull —
  fehlt das Modell, liefert der Indexlauf den strukturierten Fehler
  `EMBEDDING_MODEL_NOT_AVAILABLE`.
- **Indexspeicher:** ausschließlich unter `.ai-router-data/rag-index/`
  (`chunks.jsonl`, `manifest.json`, `index-meta.json`, Lock-Datei) — durch
  den bestehenden `.gitignore`-Eintrag `.ai-router-data/` nicht versioniert.
  `index-meta.json` trägt seit Schema `2.0` den kanonischen Content-Fingerprint
  für Allowlist, Dokumentzustände und Build-Konfiguration. `manifest.json`
  hält zusätzlich pro freigegebenem Dokument SHA-256 und Status fest.
- **Manueller Ablauf:** `npm run rag:reindex`. Kein Scheduler, kein
  Filesystem-Watcher, kein automatischer Start mit `npm start`.
- **Inhaltliche Frischeprüfung:** Jede normale Wissensanfrage prüft die
  effektive Allowlist und die zehn freigegebenen Dokumente read-only gegen
  den gespeicherten Fingerprint. Dafür werden keine Embeddings neu erzeugt.
  Ein unveränderter, älterer Index bleibt `content_current` und erhält nur
  `index_age_warning`; eine noch junge Dateiänderung wird sofort
  `content_stale`. Änderungen an Indexschema, Chunking-/Buildparametern,
  Dimension oder verifizierbarem Modelldigest ergeben
  `index_incompatible`. Lese-/Manifestfehler ergeben `index_error`.
  Nach einer Allowlist-Entfernung werden Chunks des entfernten Dokuments
  bereits bei der Anfrage ausgeschlossen, auch bevor der manuelle Reindex
  sie physisch aus dem Index entfernt.
- Änderungsprüfung erfolgt über SHA-256 des Dokumentinhalts; `mtime` ist rein
  ergänzendes Metadatum und begründet allein weder Re-Index noch Skip. Bei
  Modellnamen wie `:latest` wird der von Ollama gemeldete Digest gespeichert
  und geprüft. Falls Ollama keinen belastbaren Digest liefert, bleibt diese
  Restunsicherheit als `embedding_model_identity_unverified` sichtbar.

### Retrieval-Qualität messen: `npm run rag:quality`

Reproduzierbare Messung, **wie gut der bestehende Index das richtige Dokument
findet**. Strikt read-only: kein Re-Index, kein Vault-Zugriff, keine
Schreiboperation außer stdout. Braucht ein laufendes Ollama und einen
vorhandenen Index und ist deshalb **nicht** Teil von `npm test`; die reine
Bewertungslogik ist dort über `test/rag-quality-eval.test.js` abgedeckt.

```
npm run rag:quality
npm run rag:quality -- --min-similarity=0.50,0.55,0.60,0.65
npm run rag:quality -- --top-k=5 --json
```

- **Fragenset:** `config/rag-quality-set.json`. Jeder Fall nennt genau **ein**
  Dokument, das ihn beantworten soll. `expectedDoc: null` markiert einen
  **Negativfall** — eine Frage, die die Allowlist bewusst nicht beantworten
  kann und die deshalb gar keinen Treffer liefern darf. Ohne solche Fälle
  würde jede Schwellensenkung automatisch „besser" aussehen.
- Jeder `expectedDoc` muss in `config/rag-allowlist.json` stehen; ein
  Testfall auf ein entferntes Dokument bricht laut ab, statt als
  Retrieval-Regression zu erscheinen (offline abgesichert im Test).
- **Mehrere Schwellen** in einem Lauf vergleichen dieselben Fragen; die
  Fragen werden dabei nur einmal eingebettet.
- Gemessen wird ausschließlich der **Retrieval-Schritt**, nicht die
  Antwortqualität des Modells — Letzteres wäre nicht deterministisch
  wiederholbar.

- **Q18 bleibt im Retrieval-Set unverändert** als bekannter
  Retrieval-/Ranking-Grenzfall. Er wird weder durch eine Schwellenänderung
  noch durch das Truth-Eval künstlich grün gemacht.

### Truth-/Antwortqualität messen: `npm run rag:truth`

Das separate, ebenfalls read-only ausgelegte Truth-Eval prüft, ob der reale
Knowledge-/Jarvis-Pfad bei Aktualität, Autorität, historischen Aussagen und
fehlender Live-Evidenz korrekt begrenzt antwortet. Es nutzt bewusst denselben
produktiven Retrieval-, Authority-, Prompt-, Ollama-Provider- und
Source-Validation-Pfad wie `/api/v1/knowledge`; nur HTTP-Transport und
Routen-Authentifizierung entfallen. Damit gilt auch dieselbe reale
2.000-Zeichen-Grenze für den kombinierten RAG-Kontext.

```
npm run rag:truth -- --samples=1
npm run rag:truth -- --samples=3
npm run rag:truth -- --samples=3 --json
```

- **Fragenset:** `config/rag-truth-set.json`, getrennt von der reinen
  Retrieval-Messung. Die zehn Fälle prüfen Antwortkonzepte, verbotene
  Behauptungen, Response-State/Warnings und serverseitig validierte
  Quellenklasse/Abschnitte, ohne einen exakten Modellwortlaut zu verlangen.
- `--samples=1` ist eine schnelle Diagnose. Die Abnahme erfolgt mit
  `--samples=3`: Nur **3/3** ist grün; **2/3** wird als `unstable` gewertet.
- Pro Fall wird genau ein produktiver Retrieval-Snapshot erzeugt und für
  alle Samples wiederverwendet. Unterschiede zwischen den Samples stammen
  dadurch aus der Modellantwort, nicht aus wechselndem Retrieval.
- Ein nicht inhaltsaktueller beziehungsweise inkompatibler Index macht den
  Fall `not_evaluable`; der Runner nutzt dann keine alte Grundlage als
  vermeintlichen Truth-Nachweis.

## Command-Center-Wissenskontext (v1)

`POST /api/v1/cc/knowledge` ist ein separater, intern authentifizierter
Endpunkt, der eine Frage mit dem bereinigten Command-Center-Echtzeitkontext
und bis zu drei lokalen FELIX_SYSTEM-Fundstellen kombiniert und über die
bestehende, lokale Ollama-Text-Response-Pipeline (Intent `knowledge_answer`)
beantwortet.

- **Authentifizierung:** `Authorization: Bearer <AI_ROUTER_CC_TOKEN>` —
  dasselbe Secret wie `/api/v1/cc/summary`, server-zu-server, keine
  Browser-Origin.
- **Request:** `{ schemaVersion: "1.0", question: string (≤500 Zeichen,
  einzeilig), context?: {...gleiche geschlossene Felder wie cc-summary} }`.
  `context` ist optional — reine Wissensfragen ohne aktuellen
  Command-Center-Zustand sind zulässig.
- **Ausschließlich lokales Ollama:** über den bestehenden Loopback-Guard
  (`AI_ROUTER_OLLAMA_BASE_URL`), kein Cloud-Fallback, kein zweiter
  Provider-Client. Ohne Kontext **und** ohne passende Fundstelle wird Ollama
  gar nicht erst aufgerufen (`state: "unavailable"`,
  `warnings: ["no_context_no_knowledge"]`).
- **States:** `state` (`ok` | `partial` | `unavailable`),
  `systemContextState` (`available` | `unavailable`), `knowledgeState`
  (`available` | `no_match` | `index_missing` | `index_stale` |
  `embedding_model_unavailable` | `search_failed`). Der bestehende öffentliche
  Vertrag bleibt dabei unverändert: `index_stale` bezeichnet jetzt eine
  nachgewiesene Inhaltsabweichung oder einen fehlerhaften Last-known-good-
  Stand, nicht bloß ein hohes Alter. Die genauere Ursache erscheint in
  `warnings` als `index_stale`, `index_incompatible` oder `index_error`.
  Ein inhaltlich unveränderter älterer Index bleibt verwendbar und trägt nur
  `index_age_warning`.
- **Quellenformat:** RAG-Fundstellen werden serverseitig `[K1]`–`[K3]`
  zugeordnet. Das Modell darf nur diese Kennungen zitieren; `sources[]` im
  Response wird ausschließlich aus den tatsächlich zitierten, serverseitig
  validierten Treffern gebaut — nie aus Modelltext geparst. Eine unbekannte
  oder fehlende Pflichtquelle führt fail-closed zu `state: "unavailable"`.
- **Keine Tools, keine Aktionen:** Die Modellantwort ist ein geschlossenes
  JSON-Objekt `{ answer, citedSources }`; Tool-Calling-artige Ausgaben und
  eindeutige Ich-Form-Aktionsbehauptungen ("Ich habe den Commit erstellt.")
  werden hart blockiert.
- **Keine automatische Re-Indexierung, keine Cloud, keine Vault-Schreibzugriffe:**
  Der Endpunkt verändert weder Index noch Vault. Er liest den vorhandenen
  lokalen Index und prüft die ausdrücklich freigegebenen Vault-Dokumente
  read-only gegen deren gespeicherte Hashes; `npm run rag:reindex` bleibt ein
  separater, manueller Schritt.

## Autoritäts- und Zeitregeln für Wissensantworten (P1-A3)

Beide Wissenspfade (`cc/knowledge` und `v1/knowledge`) verwenden dieselbe
Autoritätslogik. Sie setzt DEC-003 Abschnitt 1 („Informationsklassen") und
Abschnitt 4 („Konfliktregeln") im Retrieval-/Antwortpfad um und erfindet
keine eigene Taxonomie. Der gesamte Mechanismus besteht aus drei Teilen:
einem `informationClass`-String pro freigegebenem Dokument, einer
eingefrorenen Tabelle in `orchestrator/knowledge-authority.js` und einem
Zeitflag pro Frage. Es gibt bewusst **keine** Regeldatei, keine numerische
Autoritätsskala und keinen Regelinterpreter.

**Informationsklassen** (gepflegt in `config/rag-allowlist.json`):

| Klasse | Autoritativ für | Nicht autoritativ für |
|---|---|---|
| `architecture_rule` (Accepted DECs) | Soll-Zustand, Architektur, Rollen, Zuständigkeiten, heute geltende Regeln | Commit, HEAD, laufende Prozesse, Deployment, tatsächliche Implementierung |
| `project_context` (Projekt-/Indexnotizen) | Zweck, langfristigen Kontext, dokumentierten Stand **zum genannten Datum** | jede Aussage über heute |
| `personal_reference` (`Profil.md`) | langfristige persönliche Fakten und Ziele | Tagesplanung, technische Zustände |

Zwei weitere Klassen existieren nur als Zielbereich, weil der Wissenspfad
ihre Primärquelle nicht besitzt und P1-A3 sie bewusst nicht anbindet:
`technical_state` (Repository, Laufzeit, Deployment-Provider) und
`operational_live` (Tagessteuerung). Sie werden im Prompt benannt, damit eine
Antwort sagen kann, *wer* zuständig wäre, statt auf die semantisch ähnlichste
statische Fundstelle auszuweichen.

- **Metadatenpflege:** ausschließlich zentral in `config/rag-allowlist.json`.
  Keine Frontmatter-Pflicht, keine Vault-Änderung. `informationClass` ist
  Pflicht; ein unbekannter Wert fällt fail-closed auf `project_context`
  zurück (die restriktivste Klasse), der Eintrag wird nicht verworfen.
  `reviewedAt` wird für `project_context` und `personal_reference` gepflegt
  und ist `null`, wenn das Dokument kein Prüfdatum trägt — ein Datum wird nie
  erfunden.
- **Kein Reindex nötig:** Die Felder liegen außerhalb des
  Allowlist-Fingerprints (`canonicalAllowlistIdentity` hasht nur
  `relativePath`) und werden pro Request aufgelöst. Eine Klassen- oder
  Datumskorrektur wirkt sofort, ohne ein einziges Embedding zu invalidieren.
- **Zeitabhängige Fragen:** ein festes Musterset über die normalisierte Frage
  (gleiche Bauform wie die bestehenden `EXECUTION_PATTERNS`), kein zweiter
  Modellaufruf. Die Fehlermodi sind asymmetrisch: ein False Positive macht
  die Antwort nur vorsichtiger, ein False Negative entspricht dem Verhalten
  vor P1-A3.
- **Wirkung:** Verlangt eine Frage den gegenwärtigen Zustand und ist mindestens
  eine Fundstelle `project_context`, darf daraus kein heutiger Fakt formuliert
  werden. Antworten, die ausschließlich auf Accepted DECs oder auf
  langfristigen persönlichen Fakten beruhen, bleiben unverändert normale
  Antworten — die Absicherung blockiert eindeutig belegte Fragen nicht.
- **Historische Abschnitte:** Passagen, die sich selbst als überholt
  kennzeichnen (Überschriften wie „Historisch …", „… heute zu prüfen", oder
  ein editorischer Marker wie „**Historischer Wortlaut aus Version 1.0.**"
  am Anfang eines DEC-Abschnitts), werden als `Gültigkeit: historisch`
  etikettiert und gewinnen nie gegen eine aktuelle Passage. Nichts wird aus
  Index oder Vault entfernt.
- **Neue Warnungen** (kein Schemabruch, `warnings` bleibt `maxItems: 5`):
  `current_state_not_verified`, `historical_source_only`,
  `conflicting_sources`. Vor der Kürzung werden alle Warnungen priorisiert:
  Rate-/Concurrency-Warnungen (sie steuern den 429) → Indexintegrität →
  Inhaltsabweichung → Autoritäts-/Zeitwarnungen → reine Hinweise. Ein
  fundamentaler Indexzustand kann daher nie von einer Autoritätswarnung
  verdrängt werden.
- **Vertrag unverändert:** `sources[]` trägt weiterhin exakt seine sechs
  Felder. Klasse und Historisch-Markierung sind prozessintern und erreichen
  die Leitung nie.

**Bekannte Grenze:** `reviewedAt` wird hier gepflegt, nicht aus dem Dokument
abgeleitet. Wird eine Vault-Notiz geändert, ohne das Datum nachzuziehen, ist
das Datum irreführend. Die Inhaltsprüfung aus P1-A2 erkennt die Änderung
weiterhin, das Datum nicht.

**Soll-/Ist-Vergleich (2026-08-14 Nachtrag):** Fragen, die eine Entscheidung
mit der tatsächlichen Implementierung vergleichen (z. B. „Entspricht die
Implementierung dem?", „Ist das im Code umgesetzt?", „Hält sich der Code
daran?"), werden über ein eigenes, von der Zeitfrage-Erkennung getrenntes
Musterset in `orchestrator/knowledge-authority.js` erkannt. Der Unterschied
zur Zeitfrage-Absicherung: eine Accepted DEC ist zwar für „was gilt heute"
autoritativ, beweist aber nie, ob der Code der Entscheidung tatsächlich
entspricht — die Absicherung greift deshalb unbedingt, unabhängig von der
Quellenklasse.

Eine reine Prompt-Anweisung erwies sich hier als nicht robust genug: vier
reale Läufe des lokalen Modells gegen den Realindex ließen die Ist-Seite
trotz salient platzierter Anweisung durchgehend weg. Die Antwort erhält
deshalb zusätzlich einen festen, serverseitig angehängten Hinweissatz —
deterministisch, unabhängig vom Modelltext, kein weiterer Modellaufruf.

## Generischer Wissenskontext (read-only, mehrere Consumer)

`POST /api/v1/knowledge` ist der **generische, read-only Knowledge-Pfad**. Er
beantwortet eine Frage aus dem bereits gebauten lokalen RAG-Index und prüft
dessen Fingerprint dabei gegen die freigegebenen Vault-Dokumente. Er
existiert, damit ein zweiter Consumer (die lokale Jarvis-Dialogoberfläche)
nicht den Command-Center-Vertrag mitbenutzen muss.

**Verhältnis zu `cc/knowledge`:** Beide Routen benutzen dieselbe Engine
(`orchestrator/knowledge-service.js`). `POST /api/v1/cc/knowledge` bleibt
unverändert, unmigriert und voll funktionsfähig — es ist weiterhin die
einzige Route, die einen Command-Center-Echtzeitkontext entgegennimmt.

| | `cc/knowledge` | `v1/knowledge` |
|---|---|---|
| Token | `AI_ROUTER_CC_TOKEN` | `AI_ROUTER_KNOWLEDGE_TOKEN` |
| Feld `context` | ja | **nein** (wird abgewiesen) |
| `state: "ok"` erreichbar | ja (mit Kontext) | nein — ohne Kontext immer `partial` |
| Antwortengine | `knowledge-service.js` | dieselbe |
| Rate-Limit | 1 Anfrage / 60 s, Concurrency 1 | eigener, getrennter Zähler mit denselben Werten |

- **Eigenes Token, absichtlich getrennt.** Wer `AI_ROUTER_KNOWLEDGE_TOKEN`
  besitzt, kommt damit **nicht** an `/api/v1/cc/*` — also nicht an Summary,
  Snapshot, Status oder den zustandsändernden Reindex. „Darf das Vault
  fragen" bleibt strikt schwächer als „ist das Command Center". Der Wert
  steht wie die anderen Tokens **ausschließlich** in einer
  Windows-Benutzer-Umgebungsvariablen, nie in Repo, Doku oder Vault.
- **Read-only by construction:** kein Reindex, kein Vault-Schreibzugriff,
  keine Aktion, kein Cloud-Provider. Die Engine pinnt `AI_ROUTER_TEXT_PROVIDER`
  hart auf `ollama`, unabhängig vom gemeinsamen Provider-Schalter —
  persönliche Wissensinhalte verlassen den Rechner nicht.
- **Kein Browserzugriff:** wie bei `cc/knowledge` wird jede Anfrage mit
  `Origin`-Header abgewiesen. Eine Oberfläche muss über einen serverseitigen
  Proxy gehen, damit ein Token nie in eine Seite gelangt.
- **Getrennte Limiter:** jeder Consumer baut seine eigene Service-Instanz und
  damit seinen eigenen In-Memory-Limiter. Ein Consumer kann das Budget des
  anderen nicht aufbrauchen.

### Parität prüfen: `npm run knowledge:parity`

Vergleicht beide Routen mit derselben Frage auf dem echten Index gegen das
echte lokale Modell:

```
npm run knowledge:parity
npm run knowledge:parity -- --runs=8 --question="..."
```

Wichtig zur Interpretation: Das Modell entscheidet selbst, **welche** der
angebotenen Quellen `K1`–`K3` es zitiert, und diese Auswahl schwankt auch
bei zwei Läufen auf **derselben** Route. Das Skript trennt das deshalb
sauber: Es prüft, ob jede Quelle auf beiden Routen denselben
Similarity-Wert auf volle Gleitkomma-Genauigkeit trägt (Retrieval ist
deterministisch — eine Abweichung dort ist ein echter Unterschied), und
wertet abweichende Zitatmengen nur dann als Rauschen, wenn sie auch
innerhalb einer Route auftreten. Der **deterministische** Nachweis der
Gleichheit ist `test/knowledge-parity.test.js`: dort ist der Adapter fixiert
und die Payloads müssen byte-identisch sein.

## Jarvis v1: lokale Dialogoberfläche (`GET /jarvis`)

Die kleinste lokale Jarvis-Oberfläche von Felix Core: **Textfrage → lokale
RAG-Antwort → Quellenanzeige.** Sie liegt bewusst hier im AI-Router und
**nicht** im Command Center (siehe DEC-006 Version 1.2).

- **Voice v1 vorhanden, weiterhin keine Aktionen.** Die Seite bietet lokale
  Spracheingabe und lokale Sprachausgabe (Details unten). Das Transkript wird
  nicht automatisch abgesendet und Antworten werden nicht automatisch
  vorgelesen. Die Dialogfläche bleibt reine Frage/Antwort und kann keinen
  Reindex, Commit oder eine andere Folgeaktion auslösen.
- **Kein Token in der Seite.** Die Seite ruft `POST /api/jarvis/ask` auf;
  dieser serverseitige Proxy hängt `AI_ROUTER_KNOWLEDGE_TOKEN` aus der
  Serverumgebung an und ruft intern `POST /api/v1/knowledge` auf. Der
  Wissensendpunkt weist Browser-Anfragen ohnehin ab, deshalb ist der Umweg
  keine Bequemlichkeit, sondern die Sicherheitsgrenze.
- **`schemaVersion` setzt der Server**, nicht die Seite — eine veraltete
  Seite aus dem Browsercache kann keine alte Vertragsversion festnageln.
- **Quellenanzeige:** je Fundstelle `[K1]`–`[K3]` mit Dokument, Abschnitt,
  Übereinstimmungswert, Dokumentstand und Index-Aktualität.
- **Rate-Limit ehrlich sichtbar:** Der Wissenspfad erlaubt eine Anfrage pro
  60 Sekunden. Der Knopf bleibt danach gesperrt und zeigt einen Countdown
  („Nächste Frage in 43 s"); ein 429 vom Server wird als **Limit** benannt,
  nicht als Fehler. Kein stilles Hängen, kein roher Fehlercode.
- **Jede Warnung des Vertrags hat einen deutschen Klartext.** „Keine
  Fundstelle" wird als bewusste Nichtantwort erklärt, nicht als Panne — der
  Pfad rät grundsätzlich nicht.

Aufruf: Router starten (`npm start`), dann `http://127.0.0.1:8787/jarvis`.
Ohne gesetztes `AI_ROUTER_KNOWLEDGE_TOKEN` meldet die Seite das ausdrücklich
(`AUTH_NOT_CONFIGURED`) statt stumm zu bleiben.

### Voice v1, Schritt 1: lokale Spracheingabe (`POST /api/jarvis/transcribe`)

Ein Mikrofon-Knopf auf derselben `/jarvis`-Seite füllt das bestehende
Fragefeld per Spracheingabe. Sonst ändert sich nichts: `POST /api/jarvis/ask`,
Token-Handling, Rate-Limit und Quellenanzeige sind unverändert.

- **Kein automatisches Absenden.** Das Transkript landet ausschließlich im
  Textfeld — Felix prüft/korrigiert und klickt selbst auf „Fragen".
- **Lokal aufgenommenes WAV, kein `MediaRecorder`.** Die Seite nimmt über
  die Web-Audio-API rohe PCM-Samples auf und kodiert clientseitig eine
  WAV-Datei, statt den Browser-eigenen komprimierten Recorder (webm/opus)
  zu nutzen — dessen Ausgabe bräuchte auf dem whisper-server einen
  `--convert`-Flag samt ffmpeg, was hier nicht vorausgesetzt werden kann.
  Aufnahme ist automatisch nach 60 s begrenzt.
- **Kein Cloud-STT, an keiner Stelle.** Die Seite nutzt weder
  `SpeechRecognition` noch `webkitSpeechRecognition` (im Chrome-Fall ein
  Cloud-Dienst) — nur `getUserMedia` plus lokale WAV-Kodierung.
- **Der AI-Router startet, stoppt und verwaltet den whisper-server nicht.**
  Erwartet wird ein bereits laufender lokaler whisper-server (whisper.cpp,
  `--inference-path /inference`), dessen Basis-URL in
  `AI_ROUTER_WHISPER_SERVER_URL` steht. Ohne gesetzte Variable meldet die
  Route sauber `WHISPER_NOT_CONFIGURED`; ist der Server nicht erreichbar,
  `WHISPER_UNAVAILABLE` — beides ohne stummes Hängen.
- **`AI_ROUTER_WHISPER_SERVER_URL` hat bewusst keinen Default.** Ein
  geratener Port könnte sonst still mit dem falschen Prozess sprechen.
- **Deutsch, mit Vokabular-Prompt.** Sprache ist fest `de`; der an
  whisper-server übergebene Prompt (`Felix Core, FELIX_SYSTEM, Vault,
  Jarvis, AI-Router, Command Center, Plateau-Brecher, Obsidian.`) wurde am
  13.08.2026 an einer echten lokalen Instanz verifiziert: er behob die
  beiden beobachteten Fehlklassen des `small`-Modells bei deutscher Sprache
  mit englischen Eigennamen („Core" → „Korn", „Vault" → „Volt") ohne
  messbare Mehrkosten.
- **Audio nie auf Platte.** Der Router verarbeitet die hochgeladene WAV-Datei
  ausschließlich im Speicher (Byte-Obergrenze
  `JARVIS_TRANSCRIBE_MAX_AUDIO_BYTES`, 8 MiB) und leitet sie unverändert an
  whisper-server weiter — keine temporäre Datei, keine Persistenz.
  Aufnahmen im Browser existieren nur bis zum Absenden.
- **Strikt local-only**, dieselbe Same-Origin-Disziplin wie
  `/api/jarvis/ask`: Anfragen mit fremdem `Origin`-Header werden mit 403
  abgewiesen.
- **Kein neues Token, kein Vault-/RAG-Zugriff.** Die Route berührt weder
  `AI_ROUTER_KNOWLEDGE_TOKEN` noch den RAG-Index — sie transkribiert Audio
  zu Text, sonst nichts.

**Bekannte temporäre externe Abhängigkeit:** Als lokales Modell wird in
diesem Schritt bewusst die bereits vorhandene, separat installierte
OpenWhispr-App-Kopie in place verwendet
(`~/.cache/openwhispr/whisper-models/ggml-small.bin`, ca. 488 MB, sowie
`whisper-server-win32-x64.exe` aus deren Installationsordner) — nicht in
dieses Repository kopiert. Das ist eine bewusste, dokumentierte
Übergangslösung, keine Zielarchitektur: ein Update oder eine Deinstallation
von OpenWhispr kann diese Dateien entfernen. Ein späterer Schritt sollte
Modell und Binary in ein eigenes, von Felix Core verwaltetes Datenverzeichnis
verschieben.

Aufruf: whisper-server manuell starten, z. B.
`whisper-server-win32-x64.exe -m <Pfad zu ggml-small.bin> -l de --host 127.0.0.1 --port 8399`,
dann `AI_ROUTER_WHISPER_SERVER_URL=http://127.0.0.1:8399` setzen und den
Router neu starten.

### Voice v1, Schritt 2: lokale Sprachausgabe (`POST /api/jarvis/speak`)

Ein „Vorlesen"-Knopf an der Antwortkarte derselben `/jarvis`-Seite liest den
bereits angezeigten Antworttext laut vor. Sonst ändert sich nichts:
`POST /api/jarvis/ask`, `POST /api/jarvis/transcribe`, Token-Handling und
Rate-Limit sind unverändert.

- **Kein automatisches Vorlesen.** Der Knopf erscheint erst, wenn eine
  Antwort mit Text vorliegt, und löst nur auf bewussten Klick eine Synthese
  aus. Kein Wakeword, keine Sprachschleife, kein Full-Duplex-Gespräch.
- **Kein Dauerprozess, kein Port.** `piper.exe` wird **pro Anfrage einmal**
  als Kindprozess gestartet und beendet sich danach von selbst. Verifiziert
  per `netstat` während der Synthese: **kein einziger TCP/UDP-Socket** –
  weder beim Standalone-Binary noch beim Python-Paket. Die Frage
  „127.0.0.1 statt 0.0.0.0" aus Schritt 1 stellt sich hier gar nicht, weil
  nichts gebunden wird.
- **Kein Cloud-TTS, an keiner Stelle.** Azure-TTS bleibt auf den festen
  Begrüßungstext im Command Center beschränkt (DEC-006 v1.2 §3 verbietet
  Cloud-Weiterleitung persönlicher Wissensinhalte); dieser Pfad ruft
  ausschließlich das lokal konfigurierte `piper.exe` auf.
- **`AI_ROUTER_PIPER_BINARY_PATH`/`AI_ROUTER_PIPER_VOICE_MODEL_PATH` haben
  bewusst keinen Default** – ohne beide meldet die Route sauber
  `PIPER_NOT_CONFIGURED` statt einen falschen Pfad zu erraten.
- **Ausgabe über eine kurzlebige, pro Anfrage einmalige Datei, nicht
  `stdout`.** Das war ursprünglich anders gebaut (`-f -`, WAV direkt auf
  `stdout`) und dabei am 13.08.2026 im echten Hörtest als **lautes Rauschen**
  aufgefallen. Isoliert und bestätigt über zwei unabhängige Erfassungswege
  (Node-`child_process`-Pipe und ein natives `cmd.exe`-`>`-Redirect, die
  keinen Code teilen): beide zeigten dieselbe Korruption – der WAV-Header
  wich von der tatsächlichen Datengröße ab, und die PCM-Samples selbst
  zeigten ~3-fache Amplitude und ~2,5-fache Nulldurchgangsrate gegenüber
  einer sauberen Referenz, mit chaotischen statt glatten Werteverläufen.
  `-f <Datei>` (echte, seekbare Datei statt `stdout`) war in dieser
  Untersuchung durchgehend sauber, mit und ohne `-q`. Ursache: Dieses
  2023er-Windows-Binary schreibt seinen `stdout`-Pfad offenbar nicht im
  Binärmodus – ein Fehler *innerhalb* von `piper.exe`, den kein Node-seitiges
  Stream-Handling reparieren kann, da die Bytes schon beim Verlassen des
  Prozesses falsch sind. Die Route schreibt seitdem in eine eindeutig
  benannte Datei unter `.ai-router-data/tts/tmp/`, liest sie einmalig
  vollständig ein (Größe vorher per `fs.stat` gegen
  `JARVIS_SPEAK_MAX_AUDIO_BYTES`, 12 MiB, geprüft) und löscht sie **in
  einem `finally`-Block noch innerhalb derselben Anfrage** – auch bei
  Fehlern. „Kein Audio auf Platte" gilt damit als „kein Audio überlebt
  seine eigene Anfrage", nicht mehr als „nie eine Datei". Verifiziert:
  `.ai-router-data/tts/tmp/` ist nach jeder Anfrage wieder leer.
- **Audio wird byte-begrenzt gelesen** (`JARVIS_SPEAK_MAX_AUDIO_BYTES`,
  12 MiB, geprüft vor dem Einlesen) und unverändert als `audio/wav`
  gesendet. Die Seite spielt die Antwort über einen `Blob`-Object-URL ab,
  den sie vor jeder neuen Synthese wieder freigibt (`URL.revokeObjectURL`).
- **Eigenes, von Felix Core verwaltetes Verzeichnis** – anders als bei
  whisper-server in Schritt 1 lehnt sich dieser Schritt an **keine**
  Fremdinstallation an: Binary und Stimmmodell liegen unter
  `.ai-router-data/tts/` (gitignored über `.ai-router-data/`).

**Bewusste, dokumentierte Abhängigkeitsentscheidung – Standalone-Binary
statt Python-Paket:** Die gepflegte Piper-Fortführung
([OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl), GPL-3.0)
gibt es nur als Python-Wheel; `rhasspy/piper` (MIT) ist seit Oktober 2025
archiviert, sein letztes Release `2023.11.14-2` enthält aber weiterhin ein
eigenständiges Windows-Binary ohne Python-Abhängigkeit. Am 13.08.2026 real
gemessen, mit der letztlich gewählten Stimme `de_DE-thorsten-high`:

| | Standalone (2023, MIT) | Python-Paket (2026, GPL-3.0) |
|---|---|---|
| Kaltstart | **4,2 s** | 6,6–7,0 s |
| RAM-Spitze | **239 MB** | ~307 MB |
| Python-Laufzeit nötig | nein | ja |
| Wartungsstand | seit 11/2023 unverändert | aktiv gepflegt |

Der Vorsprung des Standalone-Binaries hielt bei der leichteren Stimme
`de_DE-thorsten-medium` in gleicher Größenordnung (1,15 s vs. 3,10 s). Für
einen Node.js-Router ohne sonstige Python-Abhängigkeit und mit dem Ziel
„ein Klick, eine Synthese, keine wartende Person" überwiegt der klare
Latenz- und Ressourcenvorteil den fehlenden Wartungsstatus des Binaries –
es hat keine Netzwerkfläche und ruft keine Bibliotheken mit bekannten
offenen Sicherheitslücken auf. Wechsel auf das Python-Paket ist jederzeit
möglich, indem `AI_ROUTER_PIPER_BINARY_PATH` auf einen `piper`-Python-
Einstiegspunkt zeigt – die CLI-Argumente (`-m`, `-f -`, `-q`) sind identisch.

**Geprüfte, aber nicht gewählte Stimmen:** `de_DE-thorsten-medium` (schneller,
aber hörbar synthetischer) und `de_DE-kerstin-low` (16 kHz, zusätzlich ein
Phonemtabellen-Defekt bei kombinierendem Cedilla `̧`) bleiben als
Alternativen dokumentiert, ohne installiert zu sein.

Aufruf: `piper.exe` und Stimmmodell liegen unter `.ai-router-data/tts/`,
dann `AI_ROUTER_PIPER_BINARY_PATH` und `AI_ROUTER_PIPER_VOICE_MODEL_PATH`
auf die tatsächlichen Pfade setzen und den Router neu starten.

### Lokaler post-commit-Hook: Contract-Test-Erinnerung

Der Contract-Test `test/recommendation-contract.test.js` im Repo
`felix-command-center` prueft, dass dessen kontrollierte Kopie des
Recommendation-Contracts weiterhin zum AI-Router passt. Er laeuft nicht
automatisch (kein CI in diesem Setup), deshalb gibt es einen lokalen
`post-commit`-Hook, der nach jedem Commit, der
`orchestrator/recommendation-engine.js`, `orchestrator/server.js` oder
`docs/recommendation-engine-v1.md` aendert, eine Erinnerung ausgibt.

`.git/hooks/` wird von Git nicht versioniert, deshalb liegt die Vorlage
zusaetzlich unter [`scripts/git-hooks/post-commit`](scripts/git-hooks/post-commit).
Nach einem frischen Klonen einmalig aktivieren:

```bash
cp scripts/git-hooks/post-commit .git/hooks/post-commit
chmod +x .git/hooks/post-commit
```

(Auf Windows/Git Bash funktioniert derselbe Befehl.) Der Hook blockiert nie
etwas — er gibt nur eine Meldung auf stderr aus, sinngemaess:

```
Recommendation-Engine geaendert — Contract-Test im Command-Center-Repo sollte erneut laufen:
    node --test test/recommendation-contract.test.js
    (im Repo felix-command-center ausfuehren)
```

## Dauerhafte lokale Konfiguration und Betriebsweg

Dieses Repository lädt `.env` bewusst **nicht** automatisch (siehe Zeile 1 in
`.env.example`). Damit der Knowledge-Answer-Pfad einen echten Prozess-Neustart
übersteht, liegen die dafür nötigen Werte stattdessen als **Windows-User-
Umgebungsvariablen** vor. Das ist kein neuer Mechanismus und kein Code — nur
die dauerhafte Ablage derselben Variablen, die `.env.example` beschreibt.

Dauerhaft gesetzt sind (Stand 11.08.2026, im User-Scope, nicht Machine-Scope):

| Variable | Zweck |
|---|---|
| `AI_ROUTER_TEXT_PROVIDER` | aktiver Textprovider (`ollama`) |
| `AI_ROUTER_OLLAMA_MODEL` | Antwortmodell |
| `AI_ROUTER_OLLAMA_BASE_URL` | lokaler Ollama-Endpunkt (Loopback) |
| `AI_ROUTER_OLLAMA_EMBEDDING_MODEL` | Embedding-Modell für den RAG-Index |
| `AI_ROUTER_VAULT_ROOT` | read-only Pfad zum FELIX_SYSTEM-Checkout |
| `AI_ROUTER_INTERNAL_TOKEN` | Secret für `/api/router/respond` |
| `AI_ROUTER_CC_TOKEN` | Secret für alle `/api/v1/cc/*`-Endpunkte |
| `AI_ROUTER_KNOWLEDGE_TOKEN` | Secret für den generischen, read-only Pfad `POST /api/v1/knowledge`. Bewusst **getrennt** von `AI_ROUTER_CC_TOKEN`: gewährt ausschließlich Fragen an den lokalen Index, keinen Zugriff auf `/api/v1/cc/*` |

**Die beiden Tokenwerte stehen bewusst nirgends in diesem Repository, in der
Dokumentation oder im Vault** — hier wird nur festgehalten, *dass* und *wo* sie
gesetzt sind, nie *welchen Wert* sie haben. Prüfen lässt sich das ohne
Wertausgabe, z. B. über `[Environment]::GetEnvironmentVariable('AI_ROUTER_CC_TOKEN','User')`
auf Vorhandensein statt auf Inhalt.

Lokaler Betriebsweg für den vollständigen Knowledge-Pfad:

1. Ollama läuft lokal und hat sowohl das Antwort- als auch das
   Embedding-Modell (`ollama list`) — es gibt keinen automatischen Pull.
2. `npm run rag:reindex` erzeugt/aktualisiert den Index. Er läuft **nie**
   automatisch: kein Scheduler, kein Watcher, kein Start mit `npm start`.
   Nach jeder Allowlist-Änderung und nach relevanten Vault-Änderungen ist er
   manuell nötig. Bis dahin erkennt der Knowledge-Pfad die konkrete
   Fingerprint-Abweichung als `index_stale`; reines Alter erzeugt nur
   `index_age_warning`.
3. `npm start` startet den Router auf `http://127.0.0.1:8787`.
4. Das Command Center konsumiert `POST /api/v1/cc/knowledge` server-zu-server
   mit `AI_ROUTER_CC_TOKEN`; der Browser spricht den Router nie direkt an.

Das Ratelimit von `cc/knowledge` ist bewusst **eine Anfrage pro 60 Sekunden**
(`CC_KNOWLEDGE_MAX_REQUESTS_PER_WINDOW = 1`, Concurrency 1). Schnell
aufeinanderfolgende Testfragen laufen deshalb planmäßig in `rate_limited` —
das ist kein Fehler, sondern die konfigurierte Grenze.

## Startbereitschaft und empfohlener Startweg (P2)

**`GET /api/jarvis/ready`** ist ein read-only, tokenfreier Endpunkt (gleiche
Vertrauensstufe wie `/api/health`), der vor einer echten Anfrage sagt, ob
Jarvis nutzbar ist: `{ state, coreReady, voiceReady, reasons[] }` mit genau
drei Zuständen.

- **`ready`** — Core vollständig frisch (Ollama, Chat-Modell, Embedding-Modell,
  aktueller RAG-Index) **und** Voice vollständig konfiguriert.
- **`partial`** — Core nutzbar, aber Voice fehlt/unvollständig, **oder** Core
  läuft mit einem inhaltlich veralteten, aber noch verwendbaren
  Last-known-good-Index (`index_stale`). Voice-Ausfall macht Text-Jarvis nie
  automatisch komplett unbrauchbar.
- **`unavailable`** — Core kann nicht zuverlässig genutzt werden: Ollama,
  Chat-Modell oder Embedding-Modell fehlt, oder der Index fehlt/ist
  strukturell inkompatibel/beschädigt.

`reasons[]` verwendet ausschließlich bereits bestehende, im Knowledge-Pfad
etablierte Codes (`answer_model_unavailable`, `answer_provider_unavailable`,
`embedding_model_unavailable`, `index_missing`/`index_stale`/
`index_incompatible`/`index_error`, `WHISPER_NOT_CONFIGURED`,
`PIPER_NOT_CONFIGURED`, `PIPER_UNAVAILABLE`) — keine neue Taxonomie. Kein
Whisper-Netzwerk-Ping: Voice-Bereitschaft prüft nur Konfigurationspräsenz
(Whisper) bzw. Konfiguration plus Dateiexistenz auf der Platte (Piper), nie
einen echten Verbindungsaufbau oder Prozessstart.

**`npm run jarvis:start`** ist der empfohlene, Jarvis-spezifische Startweg:
er ruft `checkJarvisReadiness()` einmal auf (dieselbe Funktion, die auch
`/api/jarvis/ready` beantwortet — keine zweite, abweichende Prüflogik),
gibt eine kurze deutsche Zusammenfassung aus und startet den Router
**nur**, wenn Core nutzbar ist:

| Zustand | Ausgabe (Beispiel) | Router startet? | Exit-Code |
|---|---|---|---|
| `ready` | „Jarvis core ready. Voice: bereit." | ja | – (Prozess bleibt laufen) |
| `partial` | „Jarvis partial:\n  - Sprachausgabe (Piper) ist nicht konfiguriert." | ja | – (Prozess bleibt laufen) |
| `unavailable` | „Jarvis unavailable:\n  - Ollama ist nicht erreichbar." | **nein** | `1` |

`npm run jarvis:start` prüft nur — es zieht nie automatisch ein Modell
(`ollama pull`), stößt nie automatisch `npm run rag:reindex` an und
startet/stoppt nie Ollama oder whisper-server. **`npm start` bleibt
unverändert und ungated** verfügbar: für Command-Center-/Router-Funktionen,
die nicht von Ollama oder dem RAG-Index abhängen (z. B.
`/api/router/project-status`, `/api/router/git-changes`,
`/api/v1/cc/status`), ist das weiterhin der richtige, unmittelbare Weg —
absichtlich ohne `--force`-Flag an `jarvis:start`, das ist bereits die
vorhandene Ausweichmöglichkeit.

## Git-Hooks: Agent-Lock-Absicherung

Ergaenzend zum Claude-Code-eigenen PreToolUse-Hook (der nur Claude-Code-Bash-
Aufrufe abdeckt) gibt es lokale `pre-commit`/`pre-push`-Hooks, die JEDEN
Commit/Push (Claude Code, Codex, manuelle Git-Befehle) hart verweigern, wenn
im Repo-Root eine `.agent-lock.json` mit einem noch gueltigen Lock einer
anderen Session existiert. Ohne Lock-Datei oder bei abgelaufenem Lock laeuft
alles normal durch — die Hooks legen selbst nie ein Lock an und loeschen nie
eines.

`.git/hooks/` wird von Git nicht versioniert, deshalb liegen die Vorlagen
zusaetzlich unter [`scripts/git-hooks/pre-commit`](scripts/git-hooks/pre-commit)
und [`scripts/git-hooks/pre-push`](scripts/git-hooks/pre-push). Nach einem
frischen Klonen einmalig aktivieren:

```bash
cp scripts/git-hooks/pre-commit .git/hooks/pre-commit
cp scripts/git-hooks/pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-commit .git/hooks/pre-push
```

Bei Blockade erscheint eine Fehlermeldung mit sessionId, Tool und Ablaufzeit
des aktiven Locks auf stderr; der Commit/Push wird nicht ausgefuehrt. Details
zur Identitaetserkennung (Claude Code automatisch, andere Tools optional ueber
`AGENT_LOCK_SESSION_ID`) stehen als Kommentar in den Hook-Skripten selbst und
in CLAUDE.md/AGENTS.md unter "Parallele-Sessions-Sperre".

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

## Integration Baseline

Version: v0.13.0-test
Commit: cf0bf80
Status: ready for consumers

API:
GET /api/v1/cc/status

Tests:
305 total
304 passed
1 skipped
0 failed
