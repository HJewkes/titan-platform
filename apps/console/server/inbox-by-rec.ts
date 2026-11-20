/**
 * The inbox's "goes with rec at <time>" line (TP-6775): an open round the console's by-rec sweep would answer, with the
 * time it will. The line comes from the sweep's own round verdict (`byRecRoundVerdict`), on the same subjects, the same
 * whole-round rule and the same wait start, so a round the floor, the policy file or a missing recommendation keeps from
 * by-rec gets no line, and an asker can see its item will wait. Deposits get none: no deposit sweep exists yet, so no line
 * may promise one. Shepherd's gates get none either: its sweep reads facts at the PR head and its own config, which the
 * console does not have.
 */
import type { ByRecPolicy, OwnerItem } from "@titan-design/owner-queue";
import { readByRecPolicy } from "./by-rec-log.js";
import { byRecRoundVerdict, openRounds } from "./by-rec-rounds.js";
import { byRecSeenAt } from "./by-rec-seen.js";
import type { QueueRound } from "./rounds.js";

export interface ByRecCountdown {
  at: string;
  /** In shadow the sweep only logs what it would have done, so the row says "would go". */
  mode: "shadow" | "live";
}

interface ByRecCountdownSources {
  stateDir: string;
  roundsDir: string;
}

/** The round's countdown, when the sweep would answer it now or once the wait is out. */
async function roundCountdown(round: QueueRound, stateDir: string, policy: ByRecPolicy, now: Date): Promise<ByRecCountdown | undefined> {
  if (policy.mode === "off") return undefined;
  const verdict = byRecRoundVerdict(round, await byRecSeenAt(stateDir, round, now), now, policy);
  return verdict.at === undefined || !(verdict.eligible || verdict.waiting) ? undefined : { at: verdict.at, mode: policy.mode };
}

const roundIdsOf = (item: OwnerItem): string[] =>
  item.sources.flatMap((source) => (source.system === "round" ? [source.ref.split("#")[0] ?? source.ref] : []));

async function countdownsByRound(sources: ByRecCountdownSources, now: Date): Promise<Map<string, ByRecCountdown>> {
  const { policy } = await readByRecPolicy(sources.stateDir);
  if (policy.mode === "off") return new Map();
  const rounds = await openRounds(sources.roundsDir);
  const shown = await Promise.all(rounds.map(async (round) => [round.id, await roundCountdown(round, sources.stateDir, policy, now)] as const));
  return new Map(shown.flatMap(([id, countdown]) => (countdown === undefined ? [] : [[id, countdown] as const])));
}

export async function withByRecCountdown<T extends OwnerItem>(items: T[], sources: ByRecCountdownSources | undefined, now: number): Promise<(T & { byRec?: ByRecCountdown })[]> {
  if (sources === undefined) return items;
  const byRound = await countdownsByRound(sources, new Date(now));
  return items.map((item) => {
    if (item.status !== "open") return item;
    const countdown = roundIdsOf(item).map((id) => byRound.get(id)).find((each) => each !== undefined);
    return countdown === undefined ? item : { ...item, byRec: countdown };
  });
}
