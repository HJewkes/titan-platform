/**
 * Snapshot cadence and ar-sync (plan 4.10, 4.11): kept work reaches main through tag-pinned snapshot PRs, one open at a
 * time, cut at round boundaries; once one merges, main merges back into the ratchet so the next PR diffs only new work.
 * The loop never waits on review. Its only wait is an owner's answer to a sync that main cannot merge in cleanly.
 */
import { StepFailedError, type WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { runKey, runPinOf } from "./ladder.js";
import { arStepId } from "./manifest.js";
import {
  CadenceTriggerSchema,
  SnapshotResultSchema,
  SyncResultSchema,
  type CadenceRound,
  type CadenceTrigger,
  type Pinned,
  type RegistryRow,
  type SnapshotLog,
  type StopReason,
  type SyncRequest,
  type SyncResult,
} from "./ports.js";
import type { ArResult, Outcome } from "./schemas.js";
import { recorded, step } from "./steps.js";

/** Cut once this many ideas were kept, or this many agent plus model dollars were spent, since the last cut. */
export const SnapshotSettingsSchema = z.object({
  keptIdeas: z.number().int().min(1).default(3),
  spendUsd: z.number().positive().default(12),
});
export type SnapshotSettings = z.infer<typeof SnapshotSettingsSchema>;

type Spend = Pick<RegistryRow["spend"], "agentUsd" | "modelUsd">;
type KeptRow = SnapshotLog["kept"][number];

/** What a cut leaves behind; a PR closed unmerged hands `carried` back, so its work rolls into the next cut. */
interface OpenSnapshot {
  k: number;
  pr: number;
  branch: string;
  tag: string;
  sha: string;
  carried: { kept: KeptRow[]; from: string };
}

export interface SnapshotState {
  /** The last cut's number; the next cut is `k + 1`. */
  k: number;
  open: OpenSnapshot | null;
  /** Ideas kept since the last cut. */
  kept: KeptRow[];
  /** The run's spend when the last cut was made. */
  spentAt: Spend;
  /** The ratchet head the last cut tagged. */
  from: string;
}

export const startSnapshots = (head: string): SnapshotState => ({ k: 0, open: null, kept: [], spentAt: { agentUsd: 0, modelUsd: 0 }, from: head });

export const CadenceSchema = z.object({
  due: z.boolean(),
  trigger: CadenceTriggerSchema.nullable(),
  /** A due cut that waits for the open snapshot to merge or close. */
  blockedBy: z.literal("open").nullable(),
  keptSince: z.number().int().nonnegative(),
  spentSince: z.number(),
});
export type Cadence = z.infer<typeof CadenceSchema>;

const spentSince = (spend: Spend, at: Spend): Spend => ({ agentUsd: spend.agentUsd - at.agentUsd, modelUsd: spend.modelUsd - at.modelUsd });

/**
 * Whether a cut is due: the phase ending, then kept ideas, then spend. Nothing kept since the last cut means nothing to
 * ship, so no trigger fires. One snapshot is open at a time, so a due cut waits while one is.
 */
export function cadence(snapshot: SnapshotState, spend: Spend, settings: SnapshotSettings, end?: StopReason): Cadence {
  const keptSince = snapshot.kept.length;
  const since = spentSince(spend, snapshot.spentAt);
  const total = since.agentUsd + since.modelUsd;
  const trigger: CadenceTrigger | null =
    keptSince === 0 ? null : end !== undefined ? "phase-end" : keptSince >= settings.keptIdeas ? "kept" : total >= settings.spendUsd ? "spend" : null;
  return { due: trigger !== null, trigger, blockedBy: trigger !== null && snapshot.open ? "open" : null, keptSince, spentSince: total };
}

/** The round's kept ideas, in the order they moved the ratchet, join the next cut. */
export function withKept(snapshot: SnapshotState, outcomes: readonly Outcome[], kept: readonly string[]): SnapshotState {
  const byId = new Map(outcomes.map((outcome) => [outcome.ideaId, outcome]));
  const rows = kept.map((ideaId) => ({ ideaId, delta: byId.get(ideaId)?.delta, sigma: byId.get(ideaId)?.sigma }));
  return { ...snapshot, kept: [...snapshot.kept, ...rows] };
}

/** The snapshot PR's log: kept ids with Δ and σ, the spend since the last cut, the shas it spans and the phase. */
export function snapshotLog(phase: string, ledger: Ledger, round: CadenceRound, trigger: CadenceTrigger): SnapshotLog {
  const { snapshot, spend, best } = ledger;
  return { phase, trigger, round, from: snapshot.from, to: best.head, kept: snapshot.kept, spentSince: spentSince(spend, snapshot.spentAt) };
}

/** The run fields cadence and sync read: the pin, its target and the result schema re-measured runs are checked against. */
export interface SnapshotRun {
  ctx: WorkflowContext;
  pinned: Pinned;
  settings: SnapshotSettings;
  result: z.ZodType<ArResult>;
}

/** The part of the loop's state cadence and sync move. */
export interface Ledger {
  best: { head: string; runs: ArResult[] };
  spend: RegistryRow["spend"];
  snapshot: SnapshotState;
}

const FailedCutSchema = z.object({ k: z.number().int().positive(), error: z.string() });

/** A failed cut is recorded and the loop goes on; the next round's cadence retries it under the same `k`. */
async function cut(run: SnapshotRun, ledger: Ledger, round: CadenceRound, trigger: CadenceTrigger): Promise<SnapshotState> {
  const { snapshot, best, spend } = ledger;
  const k = snapshot.k + 1;
  const { ratchetRef, target } = run.pinned;
  const log = snapshotLog(target.phases[0]!.id, ledger, round, trigger);
  const input = { ...runPinOf(run), k, trigger, round, sha: best.head, ratchetRef, ratchetPrefix: target.ratchetPrefix, log };
  const result = await step(run.ctx, `${arStepId("snapshot")}:${k}`, input, SnapshotResultSchema).catch((error: unknown) => {
    if (error instanceof StepFailedError) return { failed: error.reason };
    throw error;
  });
  if ("failed" in result) {
    await recorded(run.ctx, `${arStepId("cadence")}:${round}.failed`, FailedCutSchema, () => ({ k, error: result.failed }));
    return snapshot;
  }
  const open = { k, pr: result.pr, branch: result.branch, tag: result.tag, sha: result.sha, carried: { kept: snapshot.kept, from: snapshot.from } };
  return { k, open, kept: [], spentAt: { agentUsd: spend.agentUsd, modelUsd: spend.modelUsd }, from: result.sha };
}

/** The round's cadence is recorded before any cut, so a replay never re-decides it under newer code. */
export async function cutIfDue<S extends Ledger>(run: SnapshotRun, state: S, round: CadenceRound, end?: StopReason): Promise<S> {
  const decided = await recorded(run.ctx, `${arStepId("cadence")}:${round}`, CadenceSchema, () => cadence(state.snapshot, state.spend, run.settings, end));
  if (!decided.due || decided.blockedBy !== null) return state;
  return { ...state, snapshot: await cut(run, state, round, decided.trigger!) };
}

const SHA = /^[0-9a-f]{40}$/;
/** The owner's merge of main into the ratchet; the sync port moves onto it only when it contains both. */
export const SyncGateAnswerSchema = z.looseObject({ resolved: z.string().regex(SHA) });

const holds = (result: SyncResult) => result.conflict !== undefined || result.frozen !== undefined;

function gateText(input: SyncRequest, result: SyncResult) {
  const [why, files] = result.conflict ? ["conflicts in", result.conflict] : ["changes frozen", result.frozen ?? []];
  const named = `${why} ${files.slice(0, 8).join(", ")}${files.length > 8 ? ` and ${files.length - 8} more` : ""}`;
  const summary = `Snapshot PR #${input.pr} merged, but main does not merge into the ratchet: ${why} ${files.length} file(s).`;
  const prompt = `${summary} Merge main into ${input.ratchetRef} at ${input.head} by hand and answer {"resolved": "<sha>"}, a commit that contains both ${input.head} and main.`;
  return { prompt, brief: { summary, evidenceRef: `${input.ratchetRef}@${input.head}: ${named}`.slice(0, 500) } };
}

/** A conflict or a frozen change holds the run at a gate until the owner names a merge, which goes back through the sync port. */
async function settledSync(run: SnapshotRun, stepId: string, input: SyncRequest): Promise<SyncResult> {
  let result = await step(run.ctx, stepId, input, SyncResultSchema);
  while (holds(result) && input.round !== "end") {
    const { prompt, brief } = gateText(input, result);
    const answer = await run.ctx.assisted(`${arStepId("sync-gate")}:${input.round}`, prompt, { schema: SyncGateAnswerSchema, brief });
    const { resolved } = SyncGateAnswerSchema.parse(answer.data);
    result = await step(run.ctx, `${stepId}.resolved`, { ...input, resolved }, SyncResultSchema);
  }
  return result;
}

const REMEASURE = ["r1", "r2", "r3"];

/** B after main came in: the keep rung's three runs of the new head, under their own scope. */
async function remeasure(run: SnapshotRun, round: CadenceRound): Promise<ArResult[]> {
  const scope = `sync-${round}`;
  const input = (label: string) => ({ ...runPinOf(run), tree: run.pinned.integrationTree, case: run.pinned.target.phases[0]!.train[0], key: runKey(run.ctx.runId, scope, label), rung: "sync" });
  const runs: ArResult[] = [];
  for (const label of REMEASURE) runs.push(await step(run.ctx, `${arStepId("eval")}:${scope}:${label}`, input(label), run.result));
  return runs;
}

const reopened = ({ open, kept, ...rest }: SnapshotState): SnapshotState => ({ ...rest, open: null, kept: [...(open?.carried.kept ?? []), ...kept], from: open?.carried.from ?? rest.from });

/** Merged moves B onto main merged in, re-measured only when the code outside the log changed; closed rolls the work back in. */
async function applySync<S extends Ledger>(run: SnapshotRun, state: S, round: CadenceRound, synced: SyncResult): Promise<S> {
  if (synced.state === "open" || holds(synced)) return state;
  if (synced.state === "closed" || !synced.merged) return { ...state, snapshot: reopened(state.snapshot) };
  const snapshot = { ...state.snapshot, open: null };
  const head = synced.merged.to;
  if (!synced.treeChanged) return { ...state, snapshot, best: { head, runs: state.best.runs } };
  const runs = await remeasure(run, round);
  const modelUsd = state.spend.modelUsd + runs.reduce((total, result) => total + result.usd, 0);
  return { ...state, snapshot, best: { head, runs }, spend: { ...state.spend, modelUsd } };
}

/** Run at a round's start while a snapshot is open, and once at the end; an open PR changes nothing. */
export async function syncOpen<S extends Ledger>(run: SnapshotRun, state: S, round: CadenceRound): Promise<S> {
  const { open } = state.snapshot;
  if (!open) return state;
  const { ratchetRef, target, integrationTree: tree } = run.pinned;
  const input = { ...runPinOf(run), round, pr: open.pr, branch: open.branch, head: state.best.head, ratchetRef, ratchetPrefix: target.ratchetPrefix, tree };
  return applySync(run, state, round, await settledSync(run, `${arStepId("sync")}:${round}`, input));
}
