import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { GateDecision } from "../gate-policy.js";

/** How long a merge decision a later read may clear is polled again at one head before the owner is asked. */
const UNSETTLED_BOUND_MS = 30 * 60_000;

/** The first wait is zero, so the first-unknown time is recorded before any sleep a restart could cut short. */
const SETTLE_WAITS_MS = [0, 30_000, 60_000, 120_000];
const SETTLE_WAIT_CAP_MS = 180_000;

function settleWaitMs(attempt: number): number {
  return SETTLE_WAITS_MS[attempt] ?? SETTLE_WAIT_CAP_MS;
}

/** A gate the policy expects a later read at the same head to clear, such as a mergeability GitHub has not computed yet. */
export interface UnsettledMerge {
  transient: (decision: GateDecision) => boolean;
  /** Reads the facts at `headSha` again, so the next decision judges a fresh read; called only while the PR is still at that head. */
  refresh: (ctx: WorkflowContext, headSha: string) => Promise<void>;
}

/** What GitHub's mergeability stands in for, read locally; it names the result in a gate's reason. */
export type MergeTreeProbe = (input: { repo: string; baseRef: string; headSha: string }, signal: AbortSignal) => Promise<string>;

export interface SettleInput {
  repo: string;
  baseRef: string;
  headSha: string;
  /** The first-unknown time at this head, from the previous settle record; absent on the first. */
  since?: number;
  waitMs: number;
  boundMs: number;
}

export const SettleResult = z.looseObject({ headSha: z.string(), since: z.number(), at: z.number(), spent: z.boolean(), mergeTree: z.string().optional() });

type Settled = z.infer<typeof SettleResult>;

/** The settle state at one head, rebuilt from the recorded settle steps on a replay. */
export interface SettleState {
  headSha: string;
  since: number;
  attempt: number;
}

/** Where the settle state lives; one hold spans every land round at a head, so a new round neither restarts the bound nor skips the refresh. */
export interface SettleHold {
  settle?: SettleState;
}

/** Waits once, or past the bound probes the local merge-tree instead, so the gate that follows can name it. */
export async function settleRun(input: SettleInput, timing: { now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void> }, mergeTree: MergeTreeProbe | undefined, signal: AbortSignal): Promise<Settled> {
  const since = input.since ?? timing.now();
  if (timing.now() - since >= input.boundMs) {
    const probed = mergeTree ? await mergeTree({ repo: input.repo, baseRef: input.baseRef, headSha: input.headSha }, signal) : "not run";
    return { headSha: input.headSha, since, at: timing.now(), spent: true, mergeTree: probed };
  }
  await timing.sleep(input.waitMs, signal);
  return { headSha: input.headSha, since, at: timing.now(), spent: false };
}

function unsettledReason(reason: string, settled: Settled): string {
  const minutes = Math.floor((settled.at - settled.since) / 60_000);
  return `${reason}; unsettled for ${minutes} min at ${settled.headSha}; local merge-tree: ${settled.mergeTree ?? "not run"}`;
}

/** A gate a later read may clear waits at this head instead, up to the bound; past it the gate stands and says how long it waited. */
export async function settleOrGate(holder: SettleHold, decision: GateDecision, unsettled: UnsettledMerge | undefined, headSha: string, record: (wait: Omit<SettleInput, "repo" | "baseRef">) => Promise<Settled>): Promise<GateDecision | undefined> {
  if (!unsettled?.transient(decision)) return decision;
  const prior = holder.settle?.headSha === headSha ? holder.settle : undefined;
  const attempt = prior ? prior.attempt + 1 : 0;
  const settled = await record({ headSha, ...(prior && { since: prior.since }), waitMs: settleWaitMs(attempt), boundMs: UNSETTLED_BOUND_MS });
  holder.settle = { headSha, since: settled.since, attempt };
  return settled.spent ? { ...decision, reason: unsettledReason(decision.reason, settled) } : undefined;
}
