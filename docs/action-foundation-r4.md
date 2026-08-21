# Action Foundation (R4)

Stand: 21.08.2026. Beschreibt ausschließlich den tatsächlich implementierten
Stand in `orchestrator/action/`. Alles, was hier nicht steht, existiert nicht.

## Zweck und Abgrenzung

R4 baut die technische und sicherheitstechnische Grundlage dafür, dass Jarvis
später kontrollierte Aktionen anstoßen kann. R4 ist **nicht** der Remote Agent
und führt **keine** Windows-, Datei-, Mail- oder Kalenderaktionen aus.

Nicht Teil von R4 (bewusst): freie Windows-Steuerung, Shell-/PowerShell-
Ausführung, generische Dateioperationen, Mailversand, Kalenderänderungen,
Browser-Automation, autonome Aktionen, sprachgetriggerte echte Aktionen,
Workflow-Engine, Semantic Memory.

### Abgrenzung zu `orchestrator/action-registry.js`

Im Repo existierte bereits eine Datei mit ähnlichem Namen. Sie ist **nicht**
Teil dieser Schicht:

| | `orchestrator/action-registry.js` (Bestand) | `orchestrator/action/` (R4) |
|---|---|---|
| Zweck | Allowlist der Router-API hinter `GET /api/router/actions` | Jarvis-Action-Layer |
| Inhalt | `router.status`, `router.explain`, `tasks.list`, `projects.list`, `projects.status`, `cockpit.preview` | `jarvis.action.list`, `app.open` |
| Parameter | keine | geschlossene Enum-Schemata |
| Executor | keiner, `executionAllowed: false` per Vertrag | Funktionsreferenz oder `null` |
| Freigabe | nur ein Flag `requiresConfirmation`, keine Entscheidung | echtes Approval-Modell |
| Vertrag | durch `test/router-foundation.test.js` festgeschrieben | eigene Tests |

R4 hat diese Datei nicht angefasst, nicht erweitert und nicht re-exportiert.
Eine Zusammenlegung wäre eine Änderung am öffentlichen Router-API-Vertrag und
ist damit eine bewusste R5+-Entscheidung, kein Nebeneffekt von R4.

## Kette

```
User -> Jarvis -> Intent Router (R2) -> Action Request Builder
     -> Registry (default deny) -> Parameter-Validierung
     -> Policy / Approval -> Executor -> Ergebnis + Audit
```

## Module

| Datei | Rolle |
|---|---|
| `action-types.js` | Risikoklassen, Lifecycle-Status, erlaubte Übergänge, Fehlercodes, Namespaces. Nur Daten. |
| `action-registry.js` | Allowlist, Definitionsvalidierung, Parameter-Validierung, Default-Registry. |
| `action-policy.js` | Freigabebedarf und Bewertung einer vorliegenden Entscheidung. |
| `action-audit.js` | Abbildung Status → Log-Event über den bestehenden `orchestrator/logger.js`. |
| `action-service.js` | Lifecycle, einziger Aufrufpunkt eines Executors. |
| `action-intent-bridge.js` | Naht zwischen R2-Intent und Action Request. |

## Action Contract

Ein Action Request wird über `actionService.submit()` gestellt:

```js
{
  actionId: "app.open",        // aus der Registry, sonst Ablehnung
  parameters: { target: "spotify" },
  origin: "jarvis-ask",        // geschlossene Menge
  approval: { decision: "approve", decidedBy: "felix", note: "" } | null
}
```

Ergebnis (immer aufgelöst, nie geworfen — auch eine Ablehnung hat Request-ID
und Audit-Eintrag):

```js
{ requestId, actionId, origin, status, risk, parameters,
  approval: { required, status, decidedBy, note, decidedAt },
  executed, result, error: { code, message } | null, history: [{ status, at }] }
```

## Lifecycle

```
created -> validated -> [approval_required] -> approved -> executing -> completed
                     \-> rejected                                   \-> failed
```

Terminal: `rejected`, `completed`, `failed`. `approval_required` beendet den
jeweiligen Aufruf; ein Wiederaufnehmen mit nachgereichter Freigabe ist R5.
Es gibt keinen Übergang von `approval_required` oder `rejected` nach
`executing` — das ist in `canTransition()` festgeschrieben und getestet.

## Registry

Registrierte Actions in R4:

| Action | Risiko | Approval | Executor |
|---|---|---|---|
| `jarvis.action.list` | low | nein | ja (liest die Registry, keine Nebenwirkung) |
| `app.open` | medium | ja | **nein** — bewusst nicht ausführbar, scheitert nach Freigabe mit `ACTION_EXECUTOR_UNAVAILABLE` |

Die Namespaces `system.*`, `file.*`, `calendar.*`, `email.*` sind erlaubt,
aber leer. Dort etwas zu registrieren, würde eine Fähigkeit vortäuschen, die
es nicht gibt.

Regeln der Registry:

- Default deny: `resolve()` wirft `ACTION_NOT_REGISTERED` für alles Nicht-Registrierte.
- Keine dynamische Registrierung zur Laufzeit, kein Wildcard.
- Einziger Parametertyp ist `enum` — eine geschlossene Werteliste. Ein
  freitextfähiger String-Parameter ist genau die Fläche, über die ein
  modellerzeugtes Shell- oder Pfadfragment einen Executor erreichen könnte.
  Ein weiterer Parametertyp ist eine bewusste Registry-Entscheidung mit
  eigener Validierung und eigenen Tests.
- Parameter-Validierung ist beidseitig strikt: fehlender Pflichtparameter und
  unbekannter Zusatzparameter sind gleichermaßen fatal.
- Ein Executor ist eine Funktion in diesem Repository oder `null`. Eine
  String-/Kommandoform gibt es nicht.

## Approval-Modell

| Klasse | Bedeutung | Freigabe |
|---|---|---|
| LOW | passiv oder eng begrenzt, keine sichtbare Zustandsänderung | nur wenn die Definition sie fordert |
| MEDIUM | sichtbare Zustandsänderung | immer |
| HIGH | destruktiv, extern wirksam oder sensibel | immer |

Die Policy eskaliert nur, sie senkt nie. `requiresApproval: true` bleibt
unabhängig von allem gesetzt. Es gibt keinen Aufrufparameter, keine Origin
und kein Flag, das eine freigabepflichtige Action freigabefrei macht.

Eine Freigabe ist die **Aufzeichnung einer bereits getroffenen menschlichen
Entscheidung**, die der Aufrufer mitgibt. Die Schicht erzeugt keine Freigabe,
leitet keine aus dem Kontext ab und behandelt eine fehlende oder fehlerhafte
Entscheidung nie als Zustimmung.

## Executor-Grenze

Ein Executor wird ausschließlich von `action-service.js` aufgerufen, mit genau
zwei Argumenten: dem eingefrorenen, bereits validierten Parameterobjekt und
einem festen Kontext (`{ registry, requestId, actionId }`). Nichts aus dem
Roh-Input wird weitergereicht. Es gibt kein `run(command)`, kein
`exec(shellString)` und keinen generischen Einstiegspunkt; `submit` und
`registry` sind die einzigen Member des Service.

Ein fehlender Executor scheitert geschlossen (`ACTION_EXECUTOR_UNAVAILABLE`),
auch nach erteilter Freigabe. Ein werfender Executor führt zu `failed`, sein
Fehlertext wird maskiert und gekürzt.

## Audit

Pro Zustandsübergang genau ein Eintrag über den bestehenden Logger — kein
zweiter Logging-Stack, gleiche JSONL-Datei, gleiche Rotation, gleiche
Secret-Maskierung. Acht Events (`action_request_created` … `action_request_failed`)
sind in `KNOWN_LOG_EVENTS` registriert, die sieben Fehlercodes in
`ERROR_CODES` in `orchestrator/policy.js`.

Protokolliert werden: Zeitstempel, Request-ID, Action-ID, Status, Origin,
Risiko, Approval-Status und Entscheider, validierte Parameter, sicherer
Fehlercode. Nicht protokolliert werden: die Nutzerfrage, sonstiger Freitext
und jedes Executor-Ergebnis. Ein fehlschlagender Audit-Schreibvorgang ändert
nie das Ergebnis einer Entscheidung.

## Integration mit R2

`orchestrator/jarvis-console-proxy.js` klassifiziert wie bisher vor jeder
RAG-/Cockpit-Arbeit. Bei `intent === "action"` läuft die Anfrage jetzt durch
die echte Pipeline statt in eine feste Zeichenkette.

**R4 enthält bewusst keine Abbildung von Freitext auf eine Action-ID.** Zu
raten, dass „Schick Max eine Mail" `email.send` mit abgeleitetem Empfänger
bedeutet, ist genau der Schritt, der ein Sprachmodell zum ungeprüften
Kommandogenerator macht. Die Bridge baut deshalb einen strukturell
vollständigen, aber unaufgelösten Request (`actionId: null`), der von der
Default-deny-Regel der Registry abgelehnt wird — mit echter Request-ID und
echtem Audit-Eintrag statt als Sonderfall.

Für den Nutzer bleibt das Verhalten unverändert: `intent: "action"`,
`executionAvailable: false`, dieselbe Antwort. Neu sind die Audit-Felder
`actionRequestId`, `actionStatus`, `actionErrorCode`. Knowledge-,
Operational-, System- und Conversation-Intents erreichen die Action-Pipeline
nicht (getestet).

## Tests

`test/action-foundation.test.js`, 29 Tests: bekannte Action akzeptiert,
unbekannte abgelehnt, ungültige Parameter abgelehnt, Approval-pflichtige
Action ohne Freigabe nicht ausführbar, abgelehnte Action nicht ausgeführt,
Executor erhält nur validierte Daten, freie Shell-Kommandos strukturell
unmöglich, Audit-Eintrag je Übergang, Lifecycle-Übergänge, R2→R4-Naht.

## Offen für R5

- Auflösung eines Action-Intents auf eine konkrete Action (expliziter Picker
  in der Jarvis-UI oder ein Slot-Filler, der ausschließlich über die
  Enum-Werte der Registry arbeitet).
- Wiederaufnahme eines Requests im Status `approval_required` mit
  nachgereichter Freigabe (Persistenz eines Requests über einen Aufruf hinaus).
- Erste echte Executoren (Remote Agent / Windows Executor) als eigenes,
  abgesichertes Modul.
- Entscheidung, ob die Router-API-Allowlist in diese Schicht überführt wird.

**Umgesetzt in R5** (siehe [Action Resolution + Approval Resume (R5)](action-resolution-approval-r5.md)):
Auflösung und Wiederaufnahme. Weiterhin offen: echte Executoren, Router-API-
Zusammenlegung.
