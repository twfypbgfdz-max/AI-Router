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
- **Allowlist (Stand 11.08.2026): 7 freigegebene Dokumente.**
  `config/rag-allowlist.json` listet ausschließlich einzeln von Felix
  freigegebene Dateien (`addedBy`/`addedAt` je Eintrag): DEC-001, DEC-002,
  DEC-003, `00_System/FELIX_SYSTEM_Architektur_Index.md`,
  `10_Apps/01_Aktive-Projekte/AI-Router.md`,
  `10_Apps/01_Aktive-Projekte/Felix-Command-Center.md` sowie seit 11.08.
  `90_System/Profil.md` (Personal-Context-Grundstand). Jede weitere Datei
  — auch DEC-004/005/006 — erfordert einen eigenen, ausdrücklichen Auftrag;
  die Liste wächst nicht automatisch mit dem Vault.
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
- **Manueller Ablauf:** `npm run rag:reindex`. Kein Scheduler, kein
  Filesystem-Watcher, kein automatischer Start mit `npm start`.
- Änderungsprüfung erfolgt über SHA-256 des Dokumentinhalts; `mtime` ist rein
  ergänzendes Metadatum und begründet allein weder Re-Index noch Skip.

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
  `embedding_model_unavailable` | `search_failed`). Ein veralteter Index
  (Staleness-Schwelle aktuell **24 Stunden** — bewusst konservativer
  Startwert, nicht empirisch kalibriert) blockiert die Antwort nicht,
  senkt das Gesamtergebnis aber mindestens auf `partial` und erzwingt die
  Warnung `index_stale`.
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
  Der Endpunkt liest ausschließlich den bereits vorhandenen lokalen Index
  (`npm run rag:reindex` bleibt ein separater, manueller Schritt) und öffnet
  FELIX_SYSTEM nie direkt.

## Generischer Wissenskontext (read-only, mehrere Consumer)

`POST /api/v1/knowledge` ist der **generische, read-only Knowledge-Pfad**. Er
beantwortet eine Frage ausschließlich aus dem bereits gebauten lokalen
RAG-Index und existiert, damit ein zweiter Consumer (die lokale
Jarvis-Dialogoberfläche) nicht den Command-Center-Vertrag mitbenutzen muss.

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
   manuell nötig, sonst meldet `cc/knowledge` `index_stale` (Schwelle 24 h).
3. `npm start` startet den Router auf `http://127.0.0.1:8787`.
4. Das Command Center konsumiert `POST /api/v1/cc/knowledge` server-zu-server
   mit `AI_ROUTER_CC_TOKEN`; der Browser spricht den Router nie direkt an.

Das Ratelimit von `cc/knowledge` ist bewusst **eine Anfrage pro 60 Sekunden**
(`CC_KNOWLEDGE_MAX_REQUESTS_PER_WINDOW = 1`, Concurrency 1). Schnell
aufeinanderfolgende Testfragen laufen deshalb planmäßig in `rate_limited` —
das ist kein Fehler, sondern die konfigurierte Grenze.

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
