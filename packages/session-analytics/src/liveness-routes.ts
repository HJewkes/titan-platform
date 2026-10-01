import { splitNames, stringField, type BrokerEntry } from "./liveness-broker.js";

/** One recipient a routed message did not reach. */
export interface RouteMiss {
  line: number;
  at: string;
  recipient: string;
  from: string;
  kind: string;
  /** The route reached some recipients but not this one; `delivered:false` reached none. */
  partial: boolean;
}

export interface RouteFailureRow {
  recipient: string;
  failed: number;
  partial: number;
  first: string;
  last: string;
  lines: number[];
}

/** Each recipient named in `to` that a route did not reach. */
export function routeMisses(entries: readonly BrokerEntry[]): RouteMiss[] {
  return entries.filter((e) => e.event === "route").flatMap((entry) => {
    const base = { line: entry.line, at: entry.ts, from: stringField(entry, "from") ?? "", kind: stringField(entry, "kind") ?? "" };
    return missedRecipients(entry).map(({ recipient, partial }) => ({ ...base, recipient, partial }));
  });
}

function missedRecipients(entry: BrokerEntry): { recipient: string; partial: boolean }[] {
  const named = splitNames(stringField(entry, "to"));
  if (entry.fields.delivered === false) return named.map((recipient) => ({ recipient, partial: false }));
  const reached = entry.fields.recipients;
  if (entry.fields.delivered !== true || !Array.isArray(reached) || stringField(entry, "kind") === "broadcast") return [];
  return named.filter((name) => !reached.includes(name)).map((recipient) => ({ recipient, partial: true }));
}

/** Misses grouped by recipient, most first. */
export function routeFailureRows(misses: readonly RouteMiss[]): RouteFailureRow[] {
  const rows = new Map<string, RouteFailureRow>();
  for (const miss of misses) {
    const row = rows.get(miss.recipient) ?? { recipient: miss.recipient, failed: 0, partial: 0, first: miss.at, last: miss.at, lines: [] };
    rows.set(miss.recipient, {
      ...row,
      failed: row.failed + (miss.partial ? 0 : 1),
      partial: row.partial + (miss.partial ? 1 : 0),
      last: miss.at,
      lines: [...row.lines, miss.line],
    });
  }
  return [...rows.values()].sort((a, b) => b.failed + b.partial - (a.failed + a.partial) || a.recipient.localeCompare(b.recipient));
}
