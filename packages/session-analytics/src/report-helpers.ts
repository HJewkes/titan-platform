/** Optional half-open bounds: `since` is inclusive, `until` exclusive. */
export interface TimeWindow {
  since?: string;
  until?: string;
}

/** Groups in first-seen key order, members in input order. */
export function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const members = groups.get(key);
    if (members) members.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/** A finding is in scope when any of its names is a named seat (or none are named) and it falls in the window; with no time it is judged on names alone. */
export function scopeTest(seats: readonly string[] | undefined, window: TimeWindow) {
  const named = seats ? new Set(seats) : null;
  return (names: readonly string[], at?: string): boolean =>
    (!named || names.some((n) => named.has(n))) && (at === undefined || ((!window.since || at >= window.since) && (!window.until || at < window.until)));
}

/** The report's opening line: its title, the as-of time and any window bounds. */
export function scopeHeader(title: string, asOf: string, window: TimeWindow): string {
  return `${title} as of ${asOf}${window.since ? `, since ${window.since}` : ""}${window.until ? `, until ${window.until}` : ""}`;
}

/** The closing block: each source's command and the field it reads. */
export function renderSources(sources: Readonly<Record<string, { command: string; field: string }>>): string {
  return ["Sources", ...Object.entries(sources).map(([name, s]) => `${name}: ${s.command} (${s.field})`)].join("\n");
}
