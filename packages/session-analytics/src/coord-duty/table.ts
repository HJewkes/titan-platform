import { z } from "zod";
import { PRICE_TABLE_VERSION } from "../prices.js";
import { parseInstant, type DutyCall, type DutyTurn, type MeterResult } from "./meter.js";
import { dutyInfo } from "./rules.js";

const count = z.number().int().nonnegative();
const usd = z.number().nonnegative();

/** The duty-table subset of the `titan.coord-duty/v1` report (method doc section 4). */
export const coordDutyTableSchema = z.object({
  schema: z.literal("titan.coord-duty/v1"),
  window: z.object({ lo: z.string(), hi: z.string(), hours: z.number().nonnegative() }),
  seats: z.array(z.string()),
  inputs: z.object({
    transcripts: count,
    sessions: count,
    dupCopies: count,
    unpriced: count,
    unpricedModels: z.record(z.string(), count),
    splitlessCacheWrites: count,
    priceTableVersion: z.string(),
    rules: z.string(),
  }),
  totals: z.object({ calls: count, usd, turns: count, mergedPrs: count.nullable(), usdPerPr: usd.nullable() }),
  duties: z.array(
    z.object({
      duty: z.string(),
      kind: z.enum(["det", "judge", "half", "handoff", "incident", "other"]),
      group: z.string(),
      calls: count,
      usd,
      share: z.number().nonnegative(),
      usdPerPr: usd.nullable(),
      perSeat: z.record(z.string(), usd),
    }),
  ),
  triggers: z.array(z.object({ trigger: z.string(), turns: count, noop: count, usd })),
});
export type CoordDutyTable = z.infer<typeof coordDutyTableSchema>;

export interface DutyTableOptions {
  /** The overall window; with per-pool starts, `lo` is the earliest. */
  window: { lo: string; hi: string };
  seats: readonly string[];
  rules: string;
  /** PRs merged in the window and attributed to the seats; null leaves $/PR unset. */
  mergedPrs: number | null;
}

/** The duty table, highest dollars first, with the trigger mix by turn. */
export function dutyTable(result: MeterResult, options: DutyTableOptions): CoordDutyTable {
  const total = sumUsd(result.calls);
  const perPr = (amount: number) => (options.mergedPrs ? amount / options.mergedPrs : null);
  return coordDutyTableSchema.parse({
    schema: "titan.coord-duty/v1",
    window: { ...options.window, hours: (parseInstant(options.window.hi) - parseInstant(options.window.lo)) / 3_600_000 },
    seats: [...options.seats],
    inputs: { ...result.inputs, priceTableVersion: String(PRICE_TABLE_VERSION), rules: options.rules },
    totals: { calls: result.calls.length, usd: total, turns: result.turns.length, mergedPrs: options.mergedPrs, usdPerPr: perPr(total) },
    duties: dutyRows(result.calls, total, perPr),
    triggers: triggerRows(result.turns),
  });
}

function dutyRows(calls: readonly DutyCall[], total: number, perPr: (amount: number) => number | null): CoordDutyTable["duties"] {
  return [...groupBy(calls, (call) => call.duty)]
    .map(([duty, rows]) => {
      const amount = sumUsd(rows);
      const perSeat: Record<string, number> = {};
      for (const row of rows) perSeat[row.seat] = (perSeat[row.seat] ?? 0) + row.usd;
      return { duty, ...dutyInfo(duty), calls: rows.length, usd: amount, share: total > 0 ? amount / total : 0, usdPerPr: perPr(amount), perSeat };
    })
    .sort((a, b) => b.usd - a.usd);
}

function triggerRows(turns: readonly DutyTurn[]): CoordDutyTable["triggers"] {
  return [...groupBy(turns, (turn) => turn.trig)]
    .map(([trigger, rows]) => ({ trigger, turns: rows.length, noop: rows.filter((row) => row.outcome === "NO-OP").length, usd: sumUsd(rows) }))
    .sort((a, b) => b.usd - a.usd);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

function sumUsd(rows: readonly { usd: number }[]): number {
  return rows.reduce((sum, row) => sum + row.usd, 0);
}
