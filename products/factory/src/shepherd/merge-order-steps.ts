// superseded-at:M3 (D-M3-19: M3's merge queue must carry merge-order.json, TP-3147)
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step, type LandOutcome } from "../workflows/land.js";
import type { PrTarget } from "./gates.js";
import { HOLD_POLL_MS, type HoldTiming } from "./hold.js";
import { stillOpen } from "./merge-order-guard.js";
import { blockers, overlapping, withinTtl, type MergeOrder, type MergeOrderRule, type MergeOrderRules } from "./merge-order.js";
import { pinnedPaths } from "./pr-changed-paths.js";
import { stageOf } from "./train-shadow-peers.js";
import { TRAIN_WORKFLOW, type MergeTrainRef } from "./train.js";

const RESERVE_STEP = "sh-order-reserve";
const WAIT_STEP = "sh-order-wait";
const RELEASE_STEP = "sh-order-release";
export const MERGE_ORDER_STEPS: readonly StepDeclaration[] = [RESERVE_STEP, WAIT_STEP, RELEASE_STEP].map((id) => ({ id, kind: "dispatch" }));

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

/** The runs already in their merge step that overlap `paths`; an unread peer counts, so it is never held behind the reservation. */
async function mergingAhead(deps: MergeOrderStepDeps, input: OrderInput, paths: readonly string[], rule: MergeOrderRule): Promise<string[]> {
  const reserved = new Set(deps.order().list(input.repo).map((reservation) => reservation.runId));
  const ahead: string[] = [];
  for (const run of deps.order().driving()) {
    const peer = mergingPeer(run, input, reserved);
    if (peer === undefined) continue;
    const theirs = await pinnedPaths(deps.port, { repo: input.repo, pr: peer.pr, head: peer.headSha }, peer.headSha);
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

/** The open PRs the reserving run still waits on: earlier live overlapping reservations, then the runs it let merge first. */
async function waitingOn(deps: MergeOrderStepDeps, input: OrderInput): Promise<number[]> {
  const rule = deps.rules(input.repo);
  const order = deps.order();
  const reservations = order.list(input.repo);
  const own = reservations.find((reservation) => reservation.runId === input.runId);
  if (!rule?.enabled || own === undefined || !withinTtl(own, rule, deps.now())) return [];
  const earlier = blockers({ repo: input.repo, runId: input.runId, paths: own.paths }, reservations, rule, deps.now(), (id) => order.isDriving(id));
  const prs = new Map(order.driving().map((run) => [run.id, Number(run.params.pr)]));
  const ahead = own.ahead.flatMap((runId) => (prs.has(runId) ? [prs.get(runId)!] : []));
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
    codeRoute(RELEASE_STEP, deps.now, async (input: { repo: RepoSlug; runId: string }) => ({ released: deps.order().release(input.repo, input.runId) })),
  ];
}

/** A run replaying history recorded before the order steps existed takes the path it took then. */
function replayingWithout(ctx: WorkflowContext, stepId: string): boolean {
  const next = ctx.historyNext();
  return next !== undefined && !stepIdMatches(stepId, next);
}

export interface OrderRun {
  ctx: WorkflowContext;
  target: PrTarget;
  orderSteps: number;
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
  const waited = await step(run.ctx, `${WAIT_STEP}:${n}`, input, WaitResult);
  return waited.moved ? undefined : wake();
}

/** The run's reservation ends with the run; liveness at read time covers a run that stops without reaching this. */
export async function releaseOrder(run: OrderRun): Promise<void> {
  if (replayingWithout(run.ctx, RELEASE_STEP)) return;
  await step(run.ctx, `${RELEASE_STEP}:${run.orderSteps}`, { repo: run.target.repo, runId: run.ctx.runId }, ReleaseResult);
}
