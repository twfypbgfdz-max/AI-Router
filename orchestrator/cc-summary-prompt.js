// Deterministic, server-built prompt text from the already-validated,
// closed Command-Center context. The caller never supplies free text - this
// function is the only place that turns structured fields into the plain
// text handed to the shared text-response pipeline as input.content.
function line(label, value) {
  return value === undefined || value === null || value === "" ? null : `${label}: ${value}`;
}

export function buildCcSummaryPromptText(context) {
  const cleanLabel = context.clean === true ? "clean" : context.clean === false ? "dirty" : undefined;
  const lines = [
    line("Project", context.projectId ? `${context.projectName} (${context.projectId})` : context.projectName),
    line("Status", context.projectStatus),
    line("Phase", context.phase),
    line("Branch", context.branch),
    line("Working tree", cleanLabel),
    line("Changed files", context.changedFileCount),
    line("Untracked files", context.untrackedFileCount),
    line("Test status", context.testStatus),
    line("Build status", context.buildStatus),
    line("Docs status", context.docsStatus),
    line("Release status", context.releaseStatus),
    line("Active alerts", context.activeAlertCount),
    line("Critical alerts", context.criticalAlertCount),
    line("Service states", context.serviceStates?.map((s) => `${s.name}=${s.state}`).join(", ")),
    line("Response time", context.responseTimeSummary),
    line("Cloud summary", context.cloudSummary),
    line("Milestones", context.milestoneCount),
    line("Blocked items", context.blockedCount),
    line("Overdue items", context.overdueCount),
    line("Progress", context.progressPercent !== undefined ? `${context.progressPercent}%` : undefined),
    line("Freshness", context.freshness)
  ].filter(Boolean);
  return [
    "Summarize the following read-only project status snapshot in 2-3 short sentences.",
    "Only state facts explicitly present below. Never invent commits, dates, file names, or root causes.",
    "",
    ...lines
  ].join("\n");
}
