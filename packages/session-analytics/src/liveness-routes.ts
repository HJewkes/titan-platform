import { splitNames, stringField, type BrokerEntry } from "./liveness-broker.js";

/**
 * How a route missed a recipient: `failed` is a `delivered:false` the broker dropped, `partial` reached
 * others but not this name, and `queued` is a `delivered:false` the broker kept for later delivery.
 */
export type RouteMissKind = "failed" | "partial" | "queued";

/** One recipient a routed message did not reach when it was sent. */
export interface RouteMiss {
  line: number;
  at: string;
  recipient: string;
  from: string;
  kind: string;
  miss: RouteMissKind;
}

export interface RouteFailureRow {
  recipient: string;
  failed: number;
  partial: number;
  queued: number;
  first: string;
  last: string;
  lines: number[];
}

/** Answers and decisions to an offline author are written to its inbox, so `delivered:false` there is a delay. */
const INBOX_KINDS = new Set(["answer", "decided"]);

/** Each recipient named in `to` that a route did not reach. */
export function routeMisses(entries: readonly BrokerEntry[]): RouteMiss[] {
  return entries.filter((e) => e.event === "route").flatMap((entry) => {
    const base = { line: entry.line, at: entry.ts, from: stringField(entry, "from") ?? "", kind: stringField(entry, "kind") ?? "" };
    return missedRecipients(entry).map(({ recipient, miss }) => ({ ...base, recipient, miss }));
  });
}

function missedRecipients(entry: BrokerEntry): { recipient: string; miss: RouteMissKind }[] {
  const to = stringField(entry, "to");
  const kind = stringField(entry, "kind") ?? "";
  if (to === null || to.startsWith("tag ") || kind === "broadcast") return [];
  const named = splitNames(to);
  if (entry.fields.delivered === false) {
    const miss = entry.fields.held !== undefined || INBOX_KINDS.has(kind) ? "queued" : "failed";
    return named.map((recipient) => ({ recipient, miss }));
  }
  const reached = entry.fields.recipients;
  if (entry.fields.delivered !== true || !Array.isArray(reached)) return [];
  return named.filter((name) => !reached.includes(name)).map((recipient) => ({ recipient, miss: "partial" as const }));
}

/** Misses grouped by recipient, most first. */
export function routeFailureRows(misses: readonly RouteMiss[]): RouteFailureRow[] {
  const rows = new Map<string, RouteFailureRow>();
  for (const m of misses) {
    const row = rows.get(m.recipient) ?? { recipient: m.recipient, failed: 0, partial: 0, queued: 0, first: m.at, last: m.at, lines: [] };
    rows.set(m.recipient, { ...row, [m.miss]: row[m.miss] + 1, last: m.at, lines: [...row.lines, m.line] });
  }
  const total = (r: RouteFailureRow) => r.failed + r.partial + r.queued;
  return [...rows.values()].sort((a, b) => total(b) - total(a) || a.recipient.localeCompare(b.recipient));
}

export function countMisses(misses: readonly RouteMiss[]): Record<RouteMissKind, number> {
  return { failed: misses.filter((m) => m.miss === "failed").length, partial: misses.filter((m) => m.miss === "partial").length, queued: misses.filter((m) => m.miss === "queued").length };
}
