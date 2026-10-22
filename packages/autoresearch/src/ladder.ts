import { StepFailedError, type StepResult, type WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { implementerBrief, type Digest } from "./digest.js";
import { confirmRule, improvement, keepRule, zeroToleranceHit, type Band, type KeepSettings } from "./keep.js";
import { arStepId } from "./manifest.js";
import { ImplementedSchema, LoadWaitSchema, ReleasedSchema, StaticCheckSchema, TreeSchema, type Fork, type Pinned } from "./ports.js";
import { ArMicroSchema, microSignalArg, type ArMicro, type ArResult, type DiffSize, type Idea, type Outcome } from "./schemas.js";
import { recorded, step } from "./steps.js";

/** A run's eval key, unique per run, ladder scope and repeat, because a target may use it as a cache directory. */
export const runKey = (runId: string, scope: string, label: string): string => `${runId}-${scope.replaceAll("/", "-")}-${label}`.replace(/[^A-Za-z0-9._-]/g, "_");

/** Lane slots 1..N for one round: a ladder takes the lowest free slot and frees it when it stops. */
export class LaneSlots {
  private readonly held = new Set<number>();

  take(): number {
    let slot = 1;
    while (this.held.has(slot)) slot++;
    this.held.add(slot);
    return slot;
  }

  /** A replayed ladder holds the slot its first drive recorded. */
  hold(slot: number): void {
    this.held.add(slot);
  }

  free(slot: number): void {
    this.held.delete(slot);
  }
}

export interface ForkAssignment {
  fork: Fork;
  resumeFrom?: string;
}

/** What every idea in one round is judged against: fixed at round start, so siblings and a replay agree. */
export interface RoundContext {
  ctx: WorkflowContext;
  pinned: Pinned;
  case: string;
  /** `ar-result/v2` plus the metrics this target's keep rule reads. */
  result: z.ZodType<ArResult>;
  best: { head: string; runs: ArResult[] };
  band: Band;
  keep: KeepSettings;
  digest: Digest;
  round: number;
  against: NonNullable<Outcome["against"]>;
  /** Picks absent from the plan explore. */
  forks: ReadonlyMap<string, ForkAssignment>;
  slots: LaneSlots;
}

interface Built {
  idea: Idea;
  tree: string;
  base: string;
  head: string;
  branch: string;
  lesson?: string;
  diff?: DiffSize;
  implementUsd: number;
  record: Pick<Outcome, "implementer" | "l0">;
  micro?: ArMicro;
}

type Rest = Partial<Pick<Outcome, "delta" | "runs">>;

function finish(built: Built, rungReached: Outcome["rungReached"], verdict: Outcome["verdict"], reason: string, rest: Rest = {}): Outcome {
  const { idea, head, branch, lesson, diff, record, micro } = built;
  const runs = rest.runs ?? [];
  const usage = { implementUsd: built.implementUsd, evalUsd: runs.reduce((sum, run) => sum + run.usd, 0), microUsd: micro?.usd ?? 0 };
  return { ideaId: idea.id, lineage: idea.lineage, cell: idea.cell, verdict, reason, rungReached, head, branch, lesson, diff, ...record, micro, usage, ...rest, runs };
}

const evalRun = (rc: RoundContext, scope: string, tree: string, label: string) =>
  step(rc.ctx, `${arStepId("eval")}:${scope}:${label}`, { tree, case: rc.case, key: runKey(rc.ctx.runId, scope, label), rung: "seed" }, rc.result);

async function confirm(rc: RoundContext, scope: string, built: Built, runs: ArResult[], delta: number): Promise<Outcome> {
  const confirms = [await evalRun(rc, scope, built.tree, "c1"), await evalRun(rc, scope, built.tree, "c2")];
  const decision = confirmRule(rc.best.runs, confirms, rc.keep);
  const verdict = decision.decision === "accept" ? "kept" : "rejected";
  return finish(built, "L3", verdict, decision.reason, { runs: [...runs, ...confirms], delta });
}

/** L2 one run, then L3 repeats and the keep rule; an L2 run with a zero-tolerance violation or clearly worse stops here. */
async function caseRungs(rc: RoundContext, scope: string, built: Built): Promise<Outcome> {
  const first = await evalRun(rc, scope, built.tree, "r1");
  const firstDelta = improvement(rc.best.runs, [first], rc.keep);
  const violation = zeroToleranceHit([first], rc.keep);
  if (violation) return finish(built, "L2", "rejected", violation, { runs: [first], delta: firstDelta });
  if (firstDelta < -rc.band.width) return finish(built, "L2", "rejected", "clearly-worse", { runs: [first], delta: firstDelta });
  const runs = [first, await evalRun(rc, scope, built.tree, "r2"), await evalRun(rc, scope, built.tree, "r3")];
  const decision = keepRule(rc.best.runs, runs, rc.band, rc.keep);
  if (decision.decision === "confirm") return confirm(rc, scope, built, runs, decision.delta);
  return finish(built, "L3", decision.decision === "accept" ? "kept" : "rejected", decision.reason, { runs, delta: decision.delta });
}

interface Lane {
  scope: string;
  lane: number;
  tree: string;
  branch: string;
}

/** The implement step after the load gate; an exploit lane resumes the last winner's implementer. */
async function implement(rc: RoundContext, idea: Idea, at: Lane) {
  await step(rc.ctx, `${arStepId("load-wait")}:${at.scope}`, { stage: "implement" }, LoadWaitSchema);
  const brief = implementerBrief(rc.digest, idea);
  const fork = rc.forks.get(idea.id) ?? { fork: "explore" };
  const input = { idea, tree: at.tree, base: rc.best.head, brief, round: rc.round, lane: at.lane, ...fork };
  return step(rc.ctx, `${arStepId("implement")}:${at.scope}`, input, ImplementedSchema);
}

/** L1 replays against the best's own artifacts; a best with none cannot be compared, so the idea stops. */
async function microRung(rc: RoundContext, at: Built, scope: string, rung: string): Promise<Outcome | ArMicro> {
  const baselineDir = rc.best.runs[0]?.artifact_dir;
  if (!baselineDir) return finish(at, "L1", "stopped", "no-baseline-dir");
  const { idea, tree, base } = at;
  const input = { idea, tree, base, rung, case: rc.case, baselineDir, microSignal: microSignalArg(idea), microArgs: idea.microArgs, key: runKey(rc.ctx.runId, scope, "m1") };
  return step(rc.ctx, `${arStepId("l1")}:${scope}`, input, ArMicroSchema);
}

async function climb(rc: RoundContext, idea: Idea, at: Lane): Promise<Outcome> {
  const base = rc.best.head;
  const built = await implement(rc, idea, at);
  const l0 = await step(rc.ctx, `${arStepId("l0")}:${at.scope}`, { idea, tree: at.tree, base, head: built.head }, StaticCheckSchema);
  const { agent, sessionId, resumedFrom, mode, account } = built;
  const record = { implementer: { agent, sessionId, resumedFrom, mode, account }, l0: { ok: l0.ok, code: l0.code, checks: l0.checks } };
  const implementUsd = built.usage?.usd ?? built.usd;
  let ready: Built = { idea, tree: at.tree, base, head: built.head, branch: at.branch, lesson: built.lesson, diff: l0.diff ?? built.diff, implementUsd, record };
  if (!l0.ok) return finish(ready, "L0", "rejected", `rejected:post:${l0.code ?? "unknown"}`);
  const rung = rc.pinned.target.microRung[idea.class];
  if (rung) {
    const micro = await microRung(rc, ready, at.scope, rung);
    if ("verdict" in micro) return micro;
    ready = { ...ready, micro };
    if (!micro.predicted_direction_met) return finish(ready, "L1", "stopped", "no-micro-signal");
  }
  return caseRungs(rc, at.scope, ready);
}

const failedStop = (idea: Idea, error: StepFailedError): Outcome => ({
  ideaId: idea.id, lineage: idea.lineage, cell: idea.cell, verdict: "stopped", reason: `error:${error.stepId}`, rungReached: "none", runs: [],
});

async function allocated(rc: RoundContext, idea: Idea, scope: string, lane: number): Promise<Outcome> {
  const tree = await step(rc.ctx, `${arStepId("alloc")}:${scope}`, { runId: rc.ctx.runId, ideaId: idea.id, base: rc.best.head, lane }, TreeSchema);
  try {
    return await climb(rc, idea, { scope, lane, ...tree });
  } finally {
    await step(rc.ctx, `${arStepId("release")}:${scope}`, { tree: tree.tree }, ReleasedSchema);
  }
}

/** The slot is recorded, so a replay holds the slot its first drive used even when siblings finish in another order. */
async function takeLane(rc: RoundContext, scope: string): Promise<number> {
  const lane = await recorded(rc.ctx, `${arStepId("lane")}:${scope}`, z.number().int().positive(), () => rc.slots.take());
  rc.slots.hold(lane);
  return lane;
}

/**
 * One idea's pipelined ladder. Every stop, a failed step included, is recorded with `ctx.seed` and returned,
 * never thrown: a throw would stop `mapItems` launching the round's other picks.
 */
export async function ideaLadder(rc: RoundContext, idea: Idea, scope: string): Promise<StepResult> {
  const lane = await takeLane(rc, scope);
  let outcome: Outcome;
  try {
    outcome = await allocated(rc, idea, scope, lane);
  } catch (error) {
    if (!(error instanceof StepFailedError)) throw error;
    outcome = failedStop(idea, error);
  } finally {
    rc.slots.free(lane);
  }
  const placed = { ...outcome, against: rc.against, lane, fork: rc.forks.get(idea.id)?.fork ?? "explore" };
  return rc.ctx.seed(`${arStepId("stop")}:${scope}`, async () => ({ data: {}, output: JSON.stringify(placed) }));
}
