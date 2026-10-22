import type { EventSource } from "./event-log.js";

/** The row fields the comparator reads; F11 hands it the window's rows, so it never reads the log itself (I7). */
export interface CensusRow {
  seq: number;
  source: EventSource;
  kind: string;
  subject: string;
  keys: Record<string, unknown>;
  occurrenceKey: string;
  observedAt: string;
}

/**
 * The reconciler's `reconciler.confirmed` serve-log line: its append named an existing row (TP-3095 §2: the emitter logs
 * the second form). Only the backstop's lines belong here; an ingress redelivery also answers `occurrence`.
 */
export interface DuplicateLine {
  seq: number;
  by: "delivery" | "occurrence" | "unchanged";
  /** When the line was logged. */
  at: string;
}

/**
 * Clock 1 (polling, ingress off): "no missed event kind" is every kind that occurred having a backstop row. Only the
 * backstop counts, so a stray webhook row cannot cover a kind the reconciler never wrote. Whether a missing kind occurred
 * at all is the caller's ground truth.
 */
export function kindCensus(rows: readonly CensusRow[], declaredKinds: readonly string[]): { seen: string[]; missing: string[] } {
  const polled = new Set(rows.filter((row) => row.source === "backstop").map((row) => row.kind));
  return { seen: declaredKinds.filter((kind) => polled.has(kind)), missing: declaredKinds.filter((kind) => !polled.has(kind)) };
}

interface AgreementOptions {
  /** The kinds the ingress writes; a backstop row of one of these while webhook is effective is a dropped delivery. */
  ingressKinds: ReadonlySet<string>;
  /** How long after a webhook row its backstop re-observation may come: one backstop interval plus a due-check tick. */
  withinMs: number;
  /** The window's end; a webhook row whose `withinMs` runs past it is pending, not yet a miss. */
  until: string;
}

interface Agreement {
  matched: number[];
  webhookOnly: number[];
  backstopOnly: number[];
  pending: number[];
  /** One fact stored twice under different keys: F11's duplicate rate (the TP-3095 bias rule). */
  divergentKeys: { webhook: number; backstop: number }[];
}

/** `checkRunId` is the field one source may lack; every other key field names the fact itself. */
function factOf(row: CensusRow): string {
  const { checkRunId, ...fields } = row.keys;
  void checkRunId;
  const sorted = Object.keys(fields).sort().map((name) => [name, fields[name]]);
  return `${row.kind}|${row.subject}|${JSON.stringify(sorted)}`;
}

/** A row the backstop re-observed answers with `occurrence`, or `unchanged` for a transition; `delivery` is a webhook retry. */
function reobservedWithin(lines: readonly DuplicateLine[], withinMs: number): (row: CensusRow) => boolean {
  return (row) => {
    const from = Date.parse(row.observedAt);
    return lines.some((line) => line.seq === row.seq && line.by !== "delivery" && Date.parse(line.at) >= from && Date.parse(line.at) - from <= withinMs);
  };
}

function divergentPairs(webhook: readonly CensusRow[], backstop: readonly CensusRow[]): Agreement["divergentKeys"] {
  const byFact = new Map(webhook.map((row) => [factOf(row), row.seq]));
  return backstop.flatMap((row) => {
    const seq = byFact.get(factOf(row));
    return seq === undefined ? [] : [{ webhook: seq, backstop: row.seq }];
  });
}

/** Clock 2 (webhook effective): how each webhook row and each backstop insert of an ingress kind stands against the other source. */
export function agreement(rows: readonly CensusRow[], lines: readonly DuplicateLine[], options: AgreementOptions): Agreement {
  const webhook = rows.filter((row) => row.source === "webhook");
  const backstop = rows.filter((row) => row.source === "backstop" && options.ingressKinds.has(row.kind));
  const divergentKeys = divergentPairs(webhook, backstop);
  const paired = new Set(divergentKeys.flatMap((pair) => [pair.webhook, pair.backstop]));
  const reobserved = reobservedWithin(lines, options.withinMs);
  const due = (row: CensusRow): boolean => Date.parse(row.observedAt) + options.withinMs <= Date.parse(options.until);
  const unpaired = webhook.filter((row) => !paired.has(row.seq));
  return {
    matched: unpaired.filter(reobserved).map((row) => row.seq),
    webhookOnly: unpaired.filter((row) => !reobserved(row) && due(row)).map((row) => row.seq),
    backstopOnly: backstop.filter((row) => !paired.has(row.seq)).map((row) => row.seq),
    pending: unpaired.filter((row) => !reobserved(row) && !due(row)).map((row) => row.seq),
    divergentKeys,
  };
}
