import { z } from "zod";
import { DEFAULT_LIMITS, budgetFor } from "./budgets.js";
import { percentile, type WaitLogRow } from "./recorder.js";

/** The bucket for a loader that showed while no call was in flight. */
export const NO_COMMAND = "(no command)";

export const waitStats = z.object({
  command: z.string(),
  waits: z.number(),
  /** Every wait's ms summed: what the command cost the owner. */
  ownerMs: z.number(),
  p50: z.number(),
  p95: z.number(),
  max: z.number(),
  cold: z.number(),
  mutation: z.number(),
  budgetMs: z.number(),
  overBudget: z.number(),
});
export type WaitStats = z.infer<typeof waitStats>;

function statsFor(command: string, rows: readonly WaitLogRow[]): WaitStats {
  const times = rows.map((row) => row.ms).sort((a, b) => a - b);
  const budgetMs = budgetFor(command)?.maxMs ?? DEFAULT_LIMITS.maxMs;
  return {
    command,
    waits: rows.length,
    ownerMs: times.reduce((sum, ms) => sum + ms, 0),
    p50: percentile(times, 0.5),
    p95: percentile(times, 0.95),
    max: times[times.length - 1] ?? 0,
    cold: rows.filter((row) => row.phase === "cold").length,
    mutation: rows.filter((row) => row.mutation).length,
    budgetMs,
    overBudget: times.filter((ms) => ms > budgetMs).length,
  };
}

/**
 * Per command, most owner time first. A wait on two commands counts in full toward each, since fixing either alone
 * leaves the owner waiting on the other, so the column ranks commands and does not add up to the wall clock.
 */
export function rankWaits(rows: readonly WaitLogRow[]): WaitStats[] {
  const byCommand = new Map<string, WaitLogRow[]>();
  for (const row of rows) {
    for (const command of row.commands.length === 0 ? [NO_COMMAND] : row.commands) byCommand.set(command, [...(byCommand.get(command) ?? []), row]);
  }
  return [...byCommand].map(([command, group]) => statsFor(command, group)).sort((a, b) => b.ownerMs - a.ownerMs || a.command.localeCompare(b.command));
}
