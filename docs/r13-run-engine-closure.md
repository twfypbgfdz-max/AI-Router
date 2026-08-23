# R13 — Final Run System Audit & Closure

Stand: 23.08.2026, Branch `dev`. Abschluss-Audit über die Run-/Approval-
Infrastruktur aus R7–R12. Keine neue Architektur, keine neuen Features —
nur Prüfung, Nachdokumentation und das Schließen einer offenen
Committing-Lücke aus R12.

## 1. Geprüfte Kette

* **Run-Erstellung:** `POST /api/runs` — geschützt durch `isTrustedMutation()`
  (Threat Model A/CSRF ausreichend, siehe R10).
* **State Machine:** `validating → queued → running → awaiting_approval →
  {succeeded, failed, cancelled, timed_out}` — unverändert seit vor R7,
  durch die bestehende Workflow-/Run-Service-Testsuite abgedeckt
  (`test/run-service.test.js`, `test/workflow-engine.test.js` u. a.).
* **Approval:** Operator-Approval (`POST /api/actions/:id/approval`, R7),
  Browser-BFF-Approval (`POST /api/runs/:id/approval/ui`, R9), Nonce
  (RAM-only, Single-Use, 15 Min TTL, R9) und Token (`AI_ROUTER_APPROVAL_TOKEN`,
  R7/R9) — alle über dedizierte Tests belegt.
* **UI:** Run-Start, Approval-Panel (Projektion seit R11), Reload/Reattach
  (R12), Polling, Terminalzustände — `test/run-reattach-ui.test.js`,
  `test/run-approval-bff.test.js`.

## 2. Findings R7–R12 — Status

| R | Thema | Status |
|---|---|---|
| R7 | Approval Source Hardening + Rate Limit | Erledigt, committet (`fa1a051`), gepusht. |
| R8 | Run Approval Trust Boundary | Erledigt (Audit, keine Code-Änderung), dokumentiert (`run-approval-trust-boundary-r8.md`), committet (`b7b46ad`). |
| R9 | Run-Approval BFF, Threat Model A/B, Nonce | Erledigt, committet (`e4c0d9d`), gepusht. Threat Model B **bewusst offen**, dauerhaft per Grenztest verankert (`test/run-approval-bff-threat-model.test.js`). |
| R10 | Run Mutation Audit (`create`/`cancel`) | Erledigt (Audit, keine Code-Änderung). Nur im FELIX_SYSTEM-Vault dokumentiert (`10_Apps/01_Aktive-Projekte/AI-Router.md`), **kein eigenes Repo-Dokument** — bewusste Lücke gegenüber R8/R9-Konvention, siehe Abschnitt 4. |
| R11 | Approval UI Projektion | Fund 1 (kritisch) behoben, committet (`9b1ce12`), gepusht. Fund 2 (Reload/Reattach) → an R12 übergeben. |
| R12 | Reload/Reattach | Implementiert, getestet (5/5 grün, 4 manuelle Szenarien bestanden), **war zu Beginn von R13 uncommitted** — mit diesem Audit committet, siehe Abschnitt 5. |

Keine offenen Punkte wurden gelöscht oder schöngeredet.

## 3. Bewusst offen bleibende Punkte (nicht Teil von R13)

* **Threat Model B** (beliebiger lokaler Prozess desselben Windows-Users
  ohne Origin-Header, z. B. `curl`) — für Approval-Routen (R9) und
  Mutation-Routen (R10) gleichermaßen bewusst ungeschützt. Eine echte
  Lösung (native OS-Bestätigung oder IPC-Kopplung) wäre ein eigener
  Architekturentscheid.
* **Historische Run-Wiederaufnahme nach Server-Prozessneustart** — R12
  deckt ausschließlich den Browser-Reload bei weiterhin laufendem Server
  ab.
* **Multi-Actor-Unterscheidung** — ein gemeinsamer Token = ein Actor,
  unverändert seit R7.
* **Router-API-Allowlist-Migration** in die neue Approval-Schicht —
  unverändert seit R7.
* Zentraler Rate-/Parallelitäts-Limiter der Textantwort-Pipeline vor
  Production-Rollout (außerhalb des Run/Approval-Scopes).

## 4. Außerhalb des Scopes dieses Audits

* R10 fehlt ein eigenes `docs/*.md` im Repo (anders als R8/R9). Der
  Audit-Inhalt selbst ist im FELIX_SYSTEM-Vault vollständig dokumentiert
  und durch dieses R13-Dokument referenziert. Kein Nachtrag in R13, um
  „keine unnötigen Codeänderungen" nicht durch unnötige Zusatzdokumente zu
  unterlaufen — bei Bedarf ein eigener, späterer Kleinstschritt.

## 5. Tests

```
npm test
```

**1404 Tests gesamt, 1402 bestanden, 0 fehlgeschlagen, 2 übersprungen**
(bekannte Umgebungsgrenze: Symlink-Test, in dieser Umgebung keine
Symlink-Rechte). Zusätzlich gezielt die komplette Run-/Approval-relevante
Testmenge einzeln gegengeprüft (59/59 grün): `run-reattach-ui.test.js`,
`run-approval-bff.test.js`, `run-approval-bff-threat-model.test.js`,
`action-approval-api.test.js`, `action-approval-auth.test.js`,
`action-approval-resume.test.js`, `run-service.test.js`,
`run-store.test.js`, `run-history.test.js`.

## 6. Stabilitätsbewertung

* Keine bekannten Blocker in der Run-/Approval-Kette.
* Keine kritischen UI-Lücken (R11-Panel-Fix und R12-Reattach beide
  verifiziert).
* Keine Approval-Lücken innerhalb des akzeptierten Threat-Modells (A
  geschützt, B bewusst und dauerhaft dokumentiert offen).
* Keine State-Machine-Lücken.
* Tests stabil (1402/1404, 2 umgebungsbedingt übersprungen).

**Ergebnis: Run Engine stabil für echte Felix-Core-Workflows.**

## 7. Git-Stand zum Zeitpunkt dieses Audits

* Vor R13: Branch `dev`, HEAD `9b1ce12`, synchron mit `origin/dev`,
  R12-Implementierung (`01_APP/tests/ai-router-v0_13-test.html`,
  `test/run-reattach-ui.test.js`) uncommitted.
* R13 committet zusätzlich: die uncommitted R12-Implementierung, dieses
  Dokument und `docs/run-resume-reattach-r12.md`. Kein Push ohne
  ausdrückliche Freigabe.

## 8. R7–R13 abgeschlossen

Keine weiteren R-Schritte im Run-/Approval-Bereich sind aktuell geplant.
Nächste Entwicklungsschwerpunkte liegen außerhalb dieses Blocks (siehe
FELIX_SYSTEM-Vault, `AI-Router.md`, Abschnitt „Nächster konkreter
Schritt").
