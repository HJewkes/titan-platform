import { StepFailedError, type StepResult, type WorkflowContext } from "@titan-design/workflow";
import type { z } from "zod";
import { implementerBrief, type Digest } from "./digest.js";
import { confirmRule, improvement, keepRule, zeroToleranceHit, type Band, type KeepSettings } from "./keep.js";
import { arStepId } from "./manifest.js";
import { ImplementedSchema, ReleasedSchema, StaticCheckSchema, TreeSchema, type Pinned } from "./ports.js";
import { ArMicroSchema, type ArResult, type DiffSize, type Idea, type Outcome } from "./schemas.js";
import { step } from "./steps.js";

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
}

interface Built {
  idea: Idea;
  tree: string;
  base: string;
  head: string;
  branch: string;
  lesson?: string;
  diff?: DiffSize;
}

type Rest = Partial<Pick<Outcome, "delta" | "runs">>;

function finish(built: Built, rungReached: Outcome["rungReached"], verdict: Outcome["verdict"], reason: string, rest: Rest = {}): Outcome {
  const { idea, head, branch, lesson, diff } = built;
  return { ideaId: idea.id, lineage: idea.lineage, cell: idea.cell, verdict, reason, rungReached, head, branch, lesson, diff, runs: [], ...rest };
}

const evalRun = (rc: RoundContext, scope: string, tree: string, key: string) =>
  step(rc.ctx, `${arStepId("eval")}:${scope}:${key}`, { tree, case: rc.case, key }, rc.result);

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

async function climb(rc: RoundContext, idea: Idea, scope: string, tree: { tree: string; branch: string }): Promise<Outcome> {
  const base = rc.best.head;
  const brief = implementerBrief(rc.digest, idea);
  const built = await step(rc.ctx, `${arStepId("implement")}:${scope}`, { idea, tree: tree.tree, base, brief }, ImplementedSchema);
  const at: Built = { idea, tree: tree.tree, base, head: built.head, branch: tree.branch, lesson: built.lesson, diff: built.diff };
  const l0 = await step(rc.ctx, `${arStepId("l0")}:${scope}`, { idea, tree: tree.tree, base, head: built.head }, StaticCheckSchema);
  if (!l0.ok) return finish(at, "L0", "rejected", `rejected:post:${l0.code ?? "unknown"}`);
  const rung = rc.pinned.target.microRung[idea.class];
  if (rung) {
    const micro = await step(rc.ctx, `${arStepId("l1")}:${scope}`, { idea, tree: tree.tree, base, rung }, ArMicroSchema);
    if (!micro.predicted_direction_met) return finish(at, "L1", "stopped", "no-micro-signal");
  }
  return caseRungs(rc, scope, at);
}

const failedStop = (idea: Idea, error: StepFailedError): Outcome => ({
  ideaId: idea.id, lineage: idea.lineage, cell: idea.cell, verdict: "stopped", reason: `error:${error.stepId}`, rungReached: "none", runs: [],
});

async function allocated(rc: RoundContext, idea: Idea, scope: string): Promise<Outcome> {
  const tree = await step(rc.ctx, `${arStepId("alloc")}:${scope}`, { runId: rc.ctx.runId, ideaId: idea.id, base: rc.best.head }, TreeSchema);
  try {
    return await climb(rc, idea, scope, tree);
  } finally {
    await step(rc.ctx, `${arStepId("release")}:${scope}`, { tree: tree.tree }, ReleasedSchema);
  }
}

/**
 * One idea's pipelined ladder. Every stop, a failed step included, is recorded with `ctx.seed` and returned,
 * never thrown: a throw would stop `mapItems` launching the round's other picks.
 */
export async function ideaLadder(rc: RoundContext, idea: Idea, scope: string): Promise<StepResult> {
  let outcome: Outcome;
  try {
    outcome = await allocated(rc, idea, scope);
  } catch (error) {
    if (!(error instanceof StepFailedError)) throw error;
    outcome = failedStop(idea, error);
  }
  return rc.ctx.seed(`${arStepId("stop")}:${scope}`, async () => ({ data: {}, output: JSON.stringify(outcome) }));
}
