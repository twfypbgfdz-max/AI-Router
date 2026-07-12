export function createJsonlParser({ maxEvents = 200, maxLineLength = 65_536 } = {}) {
  let pending = "";
  const events = [];
  const issues = [];
  const pushLine = (line) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line);
      if (events.length < maxEvents) events.push(value);
      else issues.push("event_limit_reached");
    } catch {
      issues.push("invalid_jsonl_line");
    }
  };
  return {
    write(chunk) {
      pending += chunk;
      if (pending.length > maxLineLength && !pending.includes("\n")) {
        pending = "";
        issues.push("jsonl_line_too_large");
        return;
      }
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      lines.forEach((line) => {
        if (line.length > maxLineLength) issues.push("jsonl_line_too_large");
        else pushLine(line);
      });
    },
    finish() {
      if (pending.trim()) issues.push("incomplete_jsonl");
      return { events, issues };
    }
  };
}

export function findFinalText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const candidates = [event?.text, event?.message, event?.output_text, event?.item?.text, event?.item?.content];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  return null;
}

const USAGE_FIELDS = ["input_tokens", "output_tokens", "cached_input_tokens", "total_tokens"];

export function sanitizeText(value, maximum = 240) {
  if (typeof value !== "string") return null;
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/\b(api[_ -]?key|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

export function reduceEventMetadata(event, timestamp = new Date().toISOString()) {
  const source = event && typeof event === "object" && !Array.isArray(event) ? event : {};
  const reduced = {
    timestamp: sanitizeText(source.timestamp, 64) || timestamp,
    type: sanitizeText(source.type, 80) || "unknown"
  };
  for (const key of ["status", "phase", "errorCode"]) {
    const value = sanitizeText(source[key], 120);
    if (value) reduced[key] = value;
  }
  const message = [source.message, source.text, source.item?.text, source.error?.message].find((value) => typeof value === "string");
  const messageSummary = sanitizeText(message, 240);
  if (messageSummary) reduced.messageSummary = messageSummary;
  const usageSource = source.usage && typeof source.usage === "object" && !Array.isArray(source.usage) ? source.usage : null;
  if (usageSource) {
    const usage = {};
    for (const key of USAGE_FIELDS) if (Number.isFinite(usageSource[key])) usage[key] = usageSource[key];
    if (Object.keys(usage).length) reduced.usage = usage;
  }
  return reduced;
}

export function reduceEvents(events) {
  return Array.isArray(events) ? events.map((event) => reduceEventMetadata(event)) : [];
}
