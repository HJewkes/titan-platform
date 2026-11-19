/**
 * The inbox's "goes with rec at <time>" line (TP-6775): an open round or deposit row the console's by-rec sweeps would
 * resolve, with the time they will, decided by the same `byRecDecision` the sweeps run. A row the floor, the policy file
 * or a missing recommendation keeps from by-rec gets no line, so an asker can see its item will wait. Shepherd's gates
 * get none here: its sweep reads facts at the PR head and its own config, which the console does not have.
 */
import { byRecDecision, byRecSubjectOfItem, type ByRecPolicy, type OwnerItem } from "@titan-design/owner-queue";
import { readByRecPolicy } from "./by-rec-log.js";

export interface ByRecCountdown {
  at: string;
  /** In shadow the sweep only logs what it would have done, so the row says "would go". */
  mode: "shadow" | "live";
}

export function byRecCountdown(item: OwnerItem, policy: ByRecPolicy, now: Date): ByRecCountdown | undefined {
  if (policy.mode === "off" || item.sources[0]?.system === "hitl") return undefined;
  const decision = byRecDecision(byRecSubjectOfItem(item), now, policy);
  const at = decision.eligible || decision.reason === "too-early" ? decision.at : undefined;
  return at === undefined ? undefined : { at, mode: policy.mode };
}

export async function withByRecCountdown<T extends OwnerItem>(items: T[], stateDir: string | undefined, now: number): Promise<(T & { byRec?: ByRecCountdown })[]> {
  if (stateDir === undefined) return items;
  const { policy } = await readByRecPolicy(stateDir);
  const at = new Date(now);
  return items.map((item) => {
    const countdown = byRecCountdown(item, policy, at);
    return countdown === undefined ? item : { ...item, byRec: countdown };
  });
}
