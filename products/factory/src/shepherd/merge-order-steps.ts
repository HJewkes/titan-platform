// superseded-at:M3 (D-M3-19: M3's merge queue must carry merge-order.json, TP-3147)
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step, type LandOutcome } from "../workflows/land.js";
import type { PrTarget } from "./gates.js";
import { HOLD_POLL_MS, type HoldTiming } from "./hold.js";
import { stillOpen } from "./merge-order-guard.js";
import { blockers, overlapping, withinTtl, type Blocker, type MergeOrder, type MergeOrderRule, type MergeOrderRules, type OrderSelf, type Reservation } from "./merge-order.js";
import { pinnedPaths } from "./pr-changed-paths.js";
import { stageOf } from "./train-shadow-peers.js";
import { TRAIN_WORKFLOW, type MergeTrainRef } from "./train.js";

const RESERVE_STEP = "sh-order-reserve";
const WAIT_STEP = "sh-order-wait";
const UNRESERVE_STEP = "sh-order-unreserve";
export const EXPIRE_STEP = "sh-order-expire";
export const MERGE_ORDER_STEPS: readonly StepDeclaration[] = [RESERVE_STEP, WAIT_STEP, UNRESERVE_STEP, EXPIRE_STEP].map((id) => ({ id, kind: "dispatch" }));

interface OrderInput extends PrTarget {
  runId: string;
  headSha: string;
}

const ReserveResult = z.looseObject({ reserved: z.boolean(), ahead: z.array(z.string()) });
type Reserved = z.infer<typeof ReserveResult>;
const WaitResult = z.looseObject({ waitedBehind: z.array(z.number()), moved: z.boolean() });
type Waited = z.infer<typeof WaitResult>;
const ReleaseResult = z.looseObject({ released: z.boolean() });

interface MergeOrderStepDeps {
  order: () => MergeOrder;
  rules: MergeOrderRules;
  port: GitHubPort;
  train: MergeTrainRef;
  timing: HoldTiming;
  now: () => number;
}

const NOT_RESERVED: Reserved = { reserved: false, ahead: [] };

/** A shepherd-pr run in `repo`, other than self and holding no reservation, that waits in its merge step, and its head. */
function mergingPeer(run: WorkflowRun, input: OrderInput, reserved: ReadonlySet<string>): { pr: number; headSha: string } | undefined {
  if (run.id === input.runId || reserved.has(run.id) || run.workflowName !== TRAIN_WORKFLOW) return undefined;
  if (run.params.repo?.toLowerCase() !== input.repo.toLowerCase()) return undefined;
  const pr = Number(run.params.pr);
  const stage = stageOf(run);
  return pr > 0 && stage?.stage === "train" ? { pr, headSha: stage.headSha } : undefined;
}

type PeerPaths = () => Promise<{ paths: string[]; unread?: string }>;

/**
 * A run in its merge step may be waiting there behind a live reservation rather than merging. Counting it as merging
 * lets three runs wait on each other in a ring until the TTL, so a peer counts only when the guard would let it merge.
 */
async function heldByOrder(deps: MergeOrderStepDeps, repo: RepoSlug, runId: string, read: PeerPaths, reservations: readonly Reservation[], rule: MergeOrderRule): Promise<boolean> {
  const live = (self: OrderSelf): Blocker[] => blockers(self, reservations, rule, deps.now(), (id) => deps.order().isDriving(id));
  if (live({ repo, runId, paths: [], unread: true }).length === 0) return false;
  const theirs = await read();
  for (const blocker of live({ repo, runId, paths: theirs.paths, unread: theirs.unread !== undefined })) {
    if (await stillOpen(deps.port, repo, blocker.reservation.pr)) return true;
  }
  return false;
}

const peerPaths = (port: GitHubPort, repo: RepoSlug, pr: number, headSha: string): PeerPaths => () => pinnedPaths(port, { repo, pr, head: headSha }, headSha);

/** The runs merging now that overlap `paths`; an unread peer counts, so it is never held behind the reservation. */
async function mergingAhead(deps: MergeOrderStepDeps, input: OrderInput, paths: readonly string[], rule: MergeOrderRule): Promise<string[]> {
  const reservations = deps.order().list(input.repo);
  const reserved = new Set(reservations.map((reservation) => reservation.runId));
  const others = reservations.filter((reservation) => reservation.runId !== input.runId);
  const ahead: string[] = [];
  for (const run of deps.order().driving()) {
    const peer = mergingPeer(run, input, reserved);
    if (peer === undefined) continue;
    const theirs = await pinnedPaths(deps.port, { repo: input.repo, pr: peer.pr, head: peer.headSha }, peer.headSha);
    if (await heldByOrder(deps, input.repo, run.id, async () => theirs, others, rule)) continue;
    if (theirs.unread !== undefined || overlapping(input.repo, paths, theirs.paths, rule).length > 0) ahead.push(run.id);
  }
  return ahead;
}

/**
 * Reserves the conflicted PR's paths at its head. A repeat at the same head keeps the first row, its `since` and its
 * `ahead`. A repo with merge order off, or a PR whose paths or base cannot be read, reserves nothing and is fixed as before.
 */
async function reserve(deps: MergeOrderStepDeps, input: OrderInput): Promise<Reserved> {
  const rule = deps.rules(input.repo);
  if (!rule?.enabled) return NOT_RESERVED;
  const own = deps.order().list(input.repo).find((reservation) => reservation.runId === input.runId);
  if (own?.headSha === input.headSha) return { reserved: true, ahead: own.ahead };
  const read = await pinnedPaths(deps.port, { ...input, head: input.headSha }, input.headSha);
  const baseSha = await deps.port.getHeadSha(input.repo, await deps.port.defaultBranch(input.repo)).catch(() => undefined);
  if (read.unread !== undefined || !baseSha) return NOT_RESERVED;
  const ahead = await mergingAhead(deps, input, read.paths, rule);
  const since = new Date(deps.now()).toISOString();
  deps.order().reserve({ ...input, baseSha, paths: read.paths, ahead, since, reason: `conflict at ${input.headSha}` });
  return { reserved: true, ahead };
}

/**
 * The PRs of the `ahead` runs still driving, still merging and not since held behind a live reservation, read again on
 * every poll. A run that left its merge step unmerged (CI red, demoted, parked) is not waited on (TP-4103).
 */
async function mergingStill(deps: MergeOrderStepDeps, repo: RepoSlug, ahead: readonly string[], reservations: readonly Reservation[], rule: MergeOrderRule): Promise<number[]> {
  const runs = new Map(deps.order().driving().map((run) => [run.id, run]));
  const prs: number[] = [];
  for (const run of ahead.flatMap((runId) => runs.get(runId) ?? [])) {
    const pr = Number(run.params.pr);
    const headSha = stageOf(run)?.headSha;
    if (headSha === undefined || (await heldByOrder(deps, repo, run.id, peerPaths(deps.port, repo, pr, headSha), reservations, rule))) continue;
    prs.push(pr);
  }
  return prs;
}

/** The open PRs the reserving run still waits on: earlier live overlapping reservations, then the runs it let merge first. */
async function waitingOn(deps: MergeOrderStepDeps, input: OrderInput): Promise<number[]> {
  const rule = deps.rules(input.repo);
  const order = deps.order();
  const reservations = order.list(input.repo);
  const own = reservations.find((reservation) => reservation.runId === input.runId);
  if (!rule?.enabled || own === undefined || !withinTtl(own, rule, deps.now())) return [];
  const earlier = blockers({ repo: input.repo, runId: input.runId, paths: own.paths }, reservations, rule, deps.now(), (id) => order.isDriving(id));
  const ahead = await mergingStill(deps, input.repo, own.ahead, reservations, rule);
  const open: number[] = [];
  for (const pr of [...earlier.map((blocker) => blocker.reservation.pr), ...ahead]) if (await stillOpen(deps.port, input.repo, pr)) open.push(pr);
  return open;
}

/** A failed read keeps the head as it was, so an outage never reads as a push; the TTL still ends the wait. */
async function headMoved(port: GitHubPort, input: OrderInput): Promise<boolean> {
  const read = await port.getPr(input.repo, input.pr).catch(() => undefined);
  return read !== undefined && read.headSha !== input.headSha;
}

/** Gives the train up first, so a run never holds its repo while it waits on the runs it let merge ahead of it. */
async function waitTurn(deps: MergeOrderStepDeps, input: OrderInput, signal: AbortSignal): Promise<Waited> {
  deps.train.get().leave(input.repo, input.runId);
  const waitedBehind = new Set<number>();
  for (;;) {
    signal.throwIfAborted();
    if (await headMoved(deps.port, input)) return { waitedBehind: [...waitedBehind], moved: true };
    const behind = await waitingOn(deps, input);
    if (behind.length === 0) return { waitedBehind: [...waitedBehind], moved: false };
    behind.forEach((pr) => waitedBehind.add(pr));
    await deps.timing.sleep(deps.timing.pollMs ?? HOLD_POLL_MS, signal);
  }
}

/** Each step reads before it writes, so a repeat after a crash finds the row it wrote, or nothing left to release. */
export function mergeOrderRoutes(deps: MergeOrderStepDeps): StepRoute[] {
  return [
    codeRoute(RESERVE_STEP, deps.now, (input: OrderInput) => reserve(deps, input)),
    codeRoute(WAIT_STEP, deps.now, (input: OrderInput, signal) => waitTurn(deps, input, signal)),
    codeRoute(UNRESERVE_STEP, deps.now, async (input: { repo: RepoSlug; runId: string }) => ({ released: deps.order().release(input.repo, input.runId, { at: new Date(deps.now()).toISOString() }) })),
  ];
}

/** A run replaying history recorded before the order steps existed takes the path it took then. */
export function replayingWithout(ctx: WorkflowContext, stepId: string): boolean {
  const next = ctx.historyNext();
  return next !== undefined && !stepIdMatches(stepId, next);
}

export interface OrderRun {
  ctx: WorkflowContext;
  target: PrTarget;
  orderSteps: number;
  /** Set by a recorded reservation and cleared by its release or expiry, so a replay rebuilds it. */
  reserved?: boolean;
}

/**
 * TP-4098 (D1): a conflicted PR reserves its paths, waits for the overlapping PRs already merging and any earlier
 * reservation, then gets its one conflict wake at the base they leave. A push during the wait lands the next round.
 */
export async function orderedConflict(run: OrderRun, headSha: string, wake: () => Promise<LandOutcome | undefined>): Promise<LandOutcome | undefined> {
  if (replayingWithout(run.ctx, RESERVE_STEP)) return wake();
  const n = run.orderSteps++;
  const input: OrderInput = { ...run.target, runId: run.ctx.runId, headSha };
  if (!(await step(run.ctx, `${RESERVE_STEP}:${n}`, input, ReserveResult)).reserved) return wake();
  run.reserved = true;
  const waited = await step(run.ctx, `${WAIT_STEP}:${n}`, input, WaitResult);
  return waited.moved ? undefined : wake();
}

/** The run's reservation ends with the run; liveness at read time covers a run that stops without reaching this. */
export async function releaseOrder(run: OrderRun): Promise<void> {
  if (replayingWithout(run.ctx, UNRESERVE_STEP)) return;
  await step(run.ctx, `${UNRESERVE_STEP}:${run.orderSteps}`, { repo: run.target.repo, runId: run.ctx.runId }, ReleaseResult);
  run.reserved = false;
}
