/**
 * The structural withdraw rule (TP-3990): a round whose manifest lists `supersedes` withdraws each named round that is
 * still open, through `round-withdraw.ts`, with reason `superseded-by:<id>`. It runs when the round is imported, when it
 * is answered and on every `rounds sweep`, and a second run changes nothing. An answered round keeps its answer, a
 * withdrawn one keeps its first reason, and an id with no round behind it is reported, never thrown: the round naming it
 * has already landed and must not be refused for a stale name.
 */
import path from "node:path";
import { z } from "zod";
import { withdrawRound } from "./round-withdraw.js";
import { roundDirExists, statusOf } from "./rounds.js";

export const supersedeOutcome = z.object({
  id: z.string(),
  /** `would-withdraw` only in a dry run; `refused` when `withdrawRound` refused the target, e.g. a symlinked withdrawn.json. */
  outcome: z.enum(["withdrawn", "would-withdraw", "already-withdrawn", "kept-answered", "unknown", "self", "refused"]),
});
export type SupersedeOutcome = z.infer<typeof supersedeOutcome>;

export interface SupersedeOptions {
  /** False reports what a run would do and writes nothing. */
  apply: boolean;
  now: Date;
}

const DRY_OUTCOME = { open: "would-withdraw", sent: "kept-answered", withdrawn: "already-withdrawn" } as const;

async function supersedeOne(roundsDir: string, by: string, id: string, { apply, now }: SupersedeOptions): Promise<SupersedeOutcome> {
  if (id === by) return { id, outcome: "self" };
  if (!(await roundDirExists(roundsDir, id))) return { id, outcome: "unknown" };
  if (!apply) return { id, outcome: DRY_OUTCOME[await statusOf(path.join(roundsDir, id))] };
  return withdrawRound(roundsDir, id, `superseded-by:${by}`, now).catch((): SupersedeOutcome => ({ id, outcome: "refused" }));
}

export async function withdrawSuperseded(
  roundsDir: string,
  by: string,
  supersedes: readonly string[],
  options: SupersedeOptions = { apply: true, now: new Date() },
): Promise<SupersedeOutcome[]> {
  const outcomes: SupersedeOutcome[] = [];
  for (const id of new Set(supersedes)) outcomes.push(await supersedeOne(path.resolve(roundsDir), by, id, options));
  return outcomes;
}
