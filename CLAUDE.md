## Vercel-Deploy-Regel (AI-Router / ai-router-preview)

**Niemals `vercel deploy --yes` ohne explizites Target ausführen.**

Grund: `ai-router-preview` ist NICHT mit einem Git-Repository verknüpft. Ohne
explizites `--target` deployt die Vercel-CLI standardmäßig als **Production**,
unabhängig vom Projektnamen. "Preview" im Projektnamen hat keinerlei Einfluss
auf das tatsächliche Deployment-Target.

**Verbindlich:**
- Preview-Deployment: `vercel deploy --target=preview`
- Production-Deployment: nur nach ausdrücklicher, expliziter Freigabe durch
  Felix — niemals implizit über einen Default-Aufruf.
- Vor jedem `vercel deploy`-Befehl das `--target` explizit im Befehl selbst
  prüfen und im Chat/Log wörtlich nennen, bevor er ausgeführt wird.
- Freigaben wie "deploy das als Preview" gelten NUR für einen Befehl mit
  `--target=preview` im exakten Wortlaut. Ein Befehl ohne dieses Flag gilt
  NICHT als abgedeckt, auch wenn der Kontext "Preview" war.
