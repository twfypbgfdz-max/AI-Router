# Run-Approval-Trust-Boundary-Audit (R8)

Stand: 22.08.2026. Beschreibt ausschließlich den tatsächlich geprüften und
entschiedenen Stand. Baut auf
[Approval Source Hardening + Action Rate Limit (R7)](approval-source-hardening-r7.md)
auf, dessen eigener "Offen für R8"-Abschnitt genau die hier untersuchte Lücke
benennt.

**Ergebnis von R8: keine Code-Änderung.** Der Auftrag war, `POST
/api/runs/:id/approval` auf dieselbe Trust-Boundary wie das bereits
gehärtete `POST /api/actions/:id/approval` (R7) zu heben. Der
Consumer-Audit hat gezeigt, dass das mit dem bestehenden Token-Modell nicht
ohne einen Secret-Leak möglich ist (Details unten). Statt eine unsichere
Lösung umzusetzen, dokumentiert dieser Eintrag den Ist-Zustand, die
konkrete Ursache der Blockade und die Architekturänderung, die für eine
spätere, sichere Härtung nötig wäre.

## 1. Bestätigter Ist-Zustand der Lücke

`server.js:375-379` prüft für `/api/runs/:id/approval` ausschließlich
`isTrustedMutation()` — derselbe schwache "kein `Origin`-Header ODER
`Origin` ∈ {localhost:8787, 127.0.0.1:8787}"-Check, den R7 für die
Action-Approval-Route bereits als unzureichend eingestuft hat. Ein Aufruf
ohne `Origin`-Header (z. B. `curl` von einem beliebigen lokalen Prozess)
besteht diese Prüfung anstandslos — jeder lokale Aufrufer kann jeden
wartenden Run freigeben oder ablehnen, unabhängig davon, wer oder was ihn
gestellt hat.

Anders als bei Actions gibt es hier aber kein spoofbares Identitätsfeld:
`run-service.js`s `decideApproval(runId, { decision, decisionNote })`
kennt kein `actor`/`source`/`decidedBy` — es gibt serverseitig nichts zu
ersetzen, weil der Client ohnehin keine Identität mitgeben kann. Die Lücke
ist rein die fehlende Authentifizierung des Aufrufs selbst, nicht eine
spoofbare Identität darin.

Eine genehmigte Run-Approval löst laut Code ausschließlich
`startApprovalSimulation()` → `startMockWorkflow()` aus — eine
dokumentierte "sichere Simulation", keinen echten Executor und keine
externen Side Effects (anders als z. B. `app.open` bei Actions).

## 2. Consumer-Audit (Pflichtprüfung vor jeder Änderung)

| Route | Realer Consumer | Wie authentifiziert er sich heute? |
|---|---|---|
| `POST /api/actions/:id/approval` (R7, gehärtet) | Ausschließlich Terminal/Smoke-Test-Aufrufe (`curl … -H "Authorization: Bearer <AI_ROUTER_APPROVAL_TOKEN>"`, siehe R7-Doku, realer Smoke-Test). Kein Browser-Frontend im Repo ruft diese Route auf. | Bearer-Token im Header, vom Operator selbst gesetzt |
| `POST /api/runs/:id/approval` (R8-Ziel) | Ausschließlich `01_APP/tests/ai-router-v0_13-test.html` — die Seite, die der AI-Router-Server selbst unter `GET /` ausliefert (`server.js:173`). Ihr `decide()`-Handler ruft `fetch('/api/runs/'+id+'/approval', {headers:{'content-type':'application/json'}, …})` **ohne jeden Authorization-Header**. | Keine — reine Same-Origin-Annahme |

Geprüft und ausgeschlossen als Consumer: `felix-cockpit`, `felix-command-center`,
`01_APP/router-console.html`, `01_APP/jarvis-console.html` — keine dieser
Oberflächen ruft `/api/runs/:id/approval` oder `/api/actions/:id/approval`
auf.

## 3. Warum die R7-Lösung hier nicht direkt übertragbar ist

R7s Modell (Bearer-Token gegen `AI_ROUTER_APPROVAL_TOKEN`) funktioniert,
weil sein einziger realer Aufrufer ein Mensch am Terminal ist, der den
Token selbst in den Header schreibt. Für `/api/runs/:id/approval` ist der
einzige reale Aufrufer dagegen eine vom selben Server ausgelieferte
Browser-Seite ohne jede Backend-/BFF-Zwischenschicht. Um denselben Token
dort nutzbar zu machen, gäbe es nur zwei Wege:

1. **Token serverseitig in die ausgelieferte HTML/JS einbetten.** Das ist
   ein Secret-Leak: Jeder mit Page-Source oder DevTools-Zugriff läse den
   Token aus — und da `AI_ROUTER_APPROVAL_TOKEN` mit der Action-Approval-
   Route geteilt werden sollte (keine neue Token-Familie, siehe R7-
   Konvention), würde ein Leak hier zugleich R7 selbst kompromittieren.
2. **Eine echte Backend-/BFF-Schicht vor den AI-Router setzen**, die den
   Token serverseitig hält und die Browser-Seite nur noch mit dieser
   Schicht sprechen lässt. Das ist die "größere Architekturänderung", vor
   der der R8-Auftrag ausdrücklich sagt: stoppen und berichten statt
   implementieren.

Eine dritte, schlankere Option (Token-Eingabefeld im UI, Operator trägt ihn
pro Browser-Session manuell ein, JS hält ihn nur im Speicher) wurde Felix
vorgelegt und **bewusst nicht gewählt** — Entscheidung: Architektur stoppen,
BFF-Bedarf dokumentieren, keine Umsetzung in R8.

## 4. Beschreibung der für eine sichere Härtung nötigen Architektur (R9-Vorbereitung)

Damit `/api/runs/:id/approval` denselben Schutz wie die Action-Approval-
Route bekommen kann, ohne den Token in den Browser zu leaken, bräuchte es:

```
Browser (aktuell: 01_APP/tests/ai-router-v0_13-test.html, ausgeliefert
         unter GET / direkt vom AI-Router)
   ↓ (heute: direkter Aufruf, kein Auth)
   ↓ (Ziel: über einen vertrauenswürdigen Vermittler)
Backend/BFF-Prozess (hält AI_ROUTER_APPROVAL_TOKEN serverseitig,
                      z. B. eine eigene Session/Cookie für den lokalen
                      Operator statt eines Long-Lived-Secrets im Browser)
   ↓ (Authorization: Bearer <Token>, serverseitig gesetzt)
AI-Router (`/api/runs/:id/approval`, geprüft wie `/api/actions/:id/approval`)
```

Diese Schicht existiert für die Root-Seite (`/`) heute nicht — anders als
z. B. beim Command Center, das bereits serverseitig mit dem AI-Router
spricht und dafür `AI_ROUTER_CC_TOKEN` nutzt. Eine naheliegende, aber noch
nicht entschiedene Option wäre, die Root-UI künftig hinter einem
vergleichbaren, bereits vorhandenen Backend-Prozess laufen zu lassen, statt
sie direkt vom AI-Router auszuliefern — das wäre aber ein eigenständiger
Architekturentscheid, kein Bestandteil von R8.

## 5. Was in R8 unverändert bleibt

* Kein Code in `server.js`, `run-service.js` oder sonst im Repo geändert.
* `/api/runs/:id/approval` bleibt exakt so geschützt (und so schwach) wie
  vor R8 — `isTrustedMutation()` nur.
* Keine neuen Fehlercodes, keine neuen Audit-Events, keine Tests.
* R7 (`/api/actions/:id/approval`) unverändert.

## 6. Offen für R9 - erledigt

Umgesetzt in [Run-Approval BFF (R9)](run-approval-bff-r9.md): ein enger
BFF-Endpoint im selben AI-Router-Prozess (`POST /api/runs/:id/approval/ui`)
hält `AI_ROUTER_APPROVAL_TOKEN` serverseitig; die harte Route `POST
/api/runs/:id/approval` verlangt jetzt denselben Bearer-Token wie R7s
Action-Approval. Details, Browser-Trust-Boundary (Single-Use-Nonce) und
Tests siehe dort.

Übrige R7-Restpunkte (Multi-Actor-Unterscheidung, Router-API-Allowlist-
Migration) bleiben weiterhin offen, unverändert durch R8/R9.
