import { RESOLVER_CLASSES } from "@titan-design/authority";
import type { GateRecord } from "@titan-design/hitl";
import { inRange } from "./stats.js";

const HOUR_MS = 3_600_000;

interface KindWait {
  /** The gate's step id without its iteration suffix, such as `approve-merge`. */
  kind: string;
  gates: number;
  medianHours: number;
  maxHours: number;
}

export interface FrictionDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** Gates the owner resolved that day. */
  ownerTouches: number;
  kinds: KindWait[];
}

interface Wait {
  day: string;
  kind: string;
  hours: number;
  touch: boolean;
}

const OWNER_CLASSES: readonly string[] = RESOLVER_CLASSES;
const isOwnerResolve = (gate: GateRecord): boolean => gate.status === "resolved" && gate.resolvedBy !== undefined && OWNER_CLASSES.includes(gate.resolvedBy.class);

/** Gate ids are `<runId>/<stepId>` or `<runId>/<stepId>:<n>`. */
const gateKind = (gateId: string): string => gateId.slice(gateId.indexOf("/") + 1).split(":")[0]!;

const day = (at: number): string => new Date(at).toISOString().slice(0, 10);
const round = (value: number): number => Math.round(value * 100) / 100;

/** A gate the owner resolved waited until its resolve; a gate still pending is the owner's, so it waits until `now`. Anything else was not the owner's to answer. */
function waitOf(gate: GateRecord, now: number): Wait | undefined {
  const opened = Date.parse(gate.createdAt);
  if (gate.status === "pending") return { day: day(now), kind: gateKind(gate.id), hours: (now - opened) / HOUR_MS, touch: false };
  if (!isOwnerResolve(gate) || gate.resolvedAt === undefined) return undefined;
  const closed = Date.parse(gate.resolvedAt);
  return { day: day(closed), kind: gateKind(gate.id), hours: (closed - opened) / HOUR_MS, touch: true };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
}

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function kindRows(waits: readonly Wait[]): KindWait[] {
  const byKind = groupBy(waits, (wait) => wait.kind);
  return [...byKind]
    .map(([kind, items]) => {
      const hours = items.map((item) => item.hours).sort((a, b) => a - b);
      return { kind, gates: hours.length, medianHours: round(median(hours)), maxHours: round(hours.at(-1)!) };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

/** Per UTC day: the owner's resolves and, per gate kind, the hours gates waited on the owner (median and max, open gates counted to `now` on the day of `now`). */
export function ownerFriction(gates: readonly GateRecord[], now: number, range: { from?: string; to?: string } = {}): FrictionDay[] {
  const waits = gates.flatMap((gate) => waitOf(gate, now) ?? []).filter((wait) => inRange(Date.parse(`${wait.day}T00:00:00Z`), range));
  return [...groupBy(waits, (wait) => wait.day)]
    .map(([date, items]) => ({ day: date, ownerTouches: items.filter((item) => item.touch).length, kinds: kindRows(items) }))
    .sort((a, b) => a.day.localeCompare(b.day));
}
