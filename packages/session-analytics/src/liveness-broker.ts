/** One agent-chat broker.log entry and the 1-based line it came from, so each finding can cite it. */
export interface BrokerEntry {
  line: number;
  ts: string;
  event: string;
  fields: Record<string, unknown>;
}

/** Broker log lines to entries; a line that is not a JSON object with `ts` and `event` is skipped but still counted. */
export function parseBrokerLog(lines: Iterable<string>): BrokerEntry[] {
  const entries: BrokerEntry[] = [];
  let line = 0;
  for (const text of lines) {
    line += 1;
    const fields = text.startsWith("{") ? parseObject(text) : null;
    if (fields && typeof fields.ts === "string" && typeof fields.event === "string") entries.push({ line, ts: fields.ts, event: fields.event, fields });
  }
  return entries;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function stringField(entry: BrokerEntry, key: string): string | null {
  const value = entry.fields[key];
  return typeof value === "string" ? value : null;
}

/** The broker joins several recipients into one `to` as "a, b". */
export function splitNames(to: string | null): string[] {
  return (to ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0);
}

export function minutesBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 6_000) / 10;
}
