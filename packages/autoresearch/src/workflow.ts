/**
 * The autoresearch recipe: pin, baseline, then rounds of plan, select and a pipelined ladder per idea,
 * with the strongest winner moving the ratchet. Everything outside the run goes through `ArPorts`.
 *
 * Inspired by Andrej Karpathy's autoresearch, https://github.com/karpathy/autoresearch (MIT); no code copied.
 */
import { mapItems, type WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { buildDigest, evidenceRow, type EvidenceRow } from "./digest.js";
import type { KeepSettings } from "./keep.js";
import { ideaLadder, type RoundContext } from "./ladder.js";
import { arStepId, AUTORESEARCH_STEPS } from "./manifest.js";
import { addPair, band, NO_NOISE, sigmaOf, type NoiseState } from "./noise.js";
import { HeadSchema, PinnedSchema, type Pinned } from "./ports.js";
import { applyOps, quotaViolations } from "./queue.js";
import { EMPTY_REGISTRIES, recordAnalysis, recordOutcome, type Registries } from "./registry.js";
import { IdeaSchema, OutcomeSchema, QueueOpsSchema, resultSchemaFor, type ArResult, type Idea, type Outcome, type QueueOps } from "./schemas.js";
import { select } from "./select.js";
import { dispatch, recorded, step } from "./steps.js";

export const AUTORESEARCH_WORKFLOW = "autoresearch";

const RunSettingsSchema = z.object({
  lanes: z.number().int().positive().default(3),
  rounds: z.number().int().positive().default(50),
  minPool: z.number().int().nonnegative().default(12),
  /** Names of the target's cases; a proposal that mentions one is refused before any spawn. */
  caseNames: z.array(z.string()).default([]),
});
type RunSettings = z.infer<typeof RunSettingsSchema>;

interface Run {
  ctx: WorkflowContext;
  pinned: Pinned;
  settings: RunSettings;
  keep: KeepSettings;
  result: z.ZodType<ArResult>;
}

interface LoopState {
  best: { head: string; runs: ArResult[] };
  noise: NoiseState;
  queue: Idea[];
  ideas: Map<string, Idea>;
  outcomes: Outcome[];
  evidence: EvidenceRow[];
  registries: Registries;
  keptLastRound: string[];
  roundsWithoutGain: number;
}

const phaseOf = (run: Run) => run.pinned.target.phases[0]!;
const primaryOf = (run: Run, result: ArResult) => result.metrics[run.keep.primary.name]!;

function runParams(ctx: WorkflowContext): { pin: string; settings: RunSettings } {
  const pin = ctx.param("pin");
  if (!pin) throw new Error(`${AUTORESEARCH_WORKFLOW}: param pin is required`);
  return { pin, settings: RunSettingsSchema.parse(JSON.parse(ctx.param("config") ?? "{}")) };
}

/** Iteration 0: duplicate runs of the starting head give B and the first σ pairs. */
async function baseline(run: Run): Promise<Pick<LoopState, "best" | "noise">> {
  const { ctx, pinned } = run;
  const keys = Array.from({ length: phaseOf(run).baselineRuns }, (_, index) => `b${index + 1}`);
  const evalBase = (key: string) => dispatch(ctx, `${arStepId("eval")}:base:${key}`, { tree: pinned.integrationTree, case: phaseOf(run).train[0], key }, run.result);
  const mapped = await mapItems(ctx, "ar-baseline", keys, (key) => evalBase(key), { key: (key) => key, concurrency: 2 });
  if (mapped.failed.length > 0 || mapped.skipped.length > 0) throw new Error(`[baseline] ${mapped.failed.map((failure) => `${failure.key}: ${failure.error}`).join("; ")}`);
  const runs = mapped.results.map(({ result }) => z.object({ result: run.result }).parse(result.data).result);
  let noise = NO_NOISE;
  for (let index = 0; index + 1 < runs.length; index += 2) {
    noise = addPair(noise, { a: primaryOf(run, runs[index]!), b: primaryOf(run, runs[index + 1]!) }, pinned.target.metric.noise);
  }
  return { best: { head: pinned.ratchetHead, runs }, noise };
}

/** The planner gets one retry that names the quota it missed; a second miss stops the run. */
async function planRound(run: Run, state: LoopState, round: number): Promise<QueueOps> {
  const digest = buildDigest({ round, evidence: state.evidence, registries: state.registries, queue: state.queue });
  const quota = { keptLastRound: state.keptLastRound, minPool: run.settings.minPool, queuedBefore: state.queue.length };
  let violations: string[] = [];
  for (const attempt of ["", ".retry"]) {
    const input = { runId: run.ctx.runId, round, digest, violations };
    const { ops } = await step(run.ctx, `${arStepId("plan")}:${round}${attempt}`, input, z.object({ ops: QueueOpsSchema }));
    violations = quotaViolations(ops, quota);
    if (violations.length === 0) return ops;
  }
  throw new Error(`[planner-quota] round ${round}: ${violations.join("; ")}`);
}

const QueueRecordSchema = z.object({ queue: z.array(IdeaSchema), rejected: z.array(z.object({ code: z.string() }).loose()) });

async function nextQueue(run: Run, state: LoopState, ops: QueueOps, round: number): Promise<Idea[]> {
  const lineageOf = new Map([...state.ideas.values()].map((idea) => [idea.id, idea.lineage]));
  const context = { round, bounds: run.pinned.bounds, caseNames: run.settings.caseNames, deadEnds: state.registries.deadEnds, seen: new Set(state.ideas.keys()), lineageOf };
  const applied = await recorded(run.ctx, `${arStepId("queue")}:${round}`, QueueRecordSchema, () => applyOps(state.queue, ops, context));
  return applied.queue;
}

async function pick(run: Run, queue: readonly Idea[], state: LoopState, round: number): Promise<Idea[]> {
  const schema = z.object({ picks: z.array(IdeaSchema), draws: z.array(z.object({ id: z.string(), draw: z.number() })), plannerTopK: z.array(z.string()) });
  const selection = await recorded(run.ctx, `${arStepId("select")}:${round}`, schema, () => select(queue, state.outcomes, { runId: run.ctx.runId, round, k: 2 * run.settings.lanes }));
  return selection.picks;
}

function roundContext(run: Run, state: LoopState, round: number): RoundContext {
  const noise = run.pinned.target.metric.noise;
  const width = band(state.noise, noise);
  const sigma = sigmaOf(state.noise) ?? width / noise.bandSigmas;
  const digest = buildDigest({ round, evidence: state.evidence, registries: state.registries, queue: state.queue });
  return { ctx: run.ctx, pinned: run.pinned, case: phaseOf(run).train[0]!, result: run.result, best: state.best, band: { width, sigma }, keep: run.keep, digest };
}

/** Lanes are a concurrency cap, not waves: an early stop frees its lane for the next pick at once. */
async function fanOut(run: Run, rc: RoundContext, picks: readonly Idea[], round: number): Promise<Outcome[]> {
  const stepId = `ar-round:${round}`;
  const ladder = (idea: Idea, itemStepId: string) => ideaLadder(rc, idea, `${round}/${itemStepId.slice(stepId.length + 1)}`);
  const mapped = await mapItems(run.ctx, stepId, picks, ladder, { key: (idea) => idea.id, concurrency: run.settings.lanes, maxFailures: run.settings.lanes });
  return mapped.results.map(({ result }) => OutcomeSchema.parse(JSON.parse(result.output!)));
}

/** One σ per round, so ordering by Δ is ordering by σ-normalized Δ. */
const byStrength = (a: Outcome, b: Outcome) => (b.delta ?? 0) - (a.delta ?? 0) || a.ideaId.localeCompare(b.ideaId);

/** The strongest winner moves the ratchet; any other winner goes back in the queue on its lineage until S5 re-evaluates it against the new head. */
async function ratchet(run: Run, state: LoopState, outcomes: Outcome[], round: number) {
  const winners = outcomes.filter((outcome) => outcome.verdict === "kept").sort(byStrength);
  const [first, ...rest] = winners;
  if (!first) return { best: state.best, kept: [], outcomes, requeue: [] };
  const { ratchetRef, integrationTree: tree, target } = run.pinned;
  const move = { tree, ratchetRef, ratchetPrefix: target.ratchetPrefix, from: state.best.head, to: first.head! };
  const { head } = await step(run.ctx, `${arStepId("ratchet")}:${round}`, move, HeadSchema);
  const superseded = new Set(rest.map((outcome) => outcome.ideaId));
  const marked = outcomes.map((outcome) => (superseded.has(outcome.ideaId) ? { ...outcome, verdict: "stopped" as const, reason: "superseded" } : outcome));
  const requeue = rest.map((outcome) => ({ ...state.ideas.get(outcome.ideaId)!, source: "requeue" as const, round: round + 1 }));
  return { best: { head, runs: first.runs }, kept: [first.ideaId], outcomes: marked, requeue };
}

/** L3 repeats r2 and r3 are two runs of the same code on the same case: a free σ pair. */
function withPairs(noise: NoiseState, outcomes: readonly Outcome[], run: Run): NoiseState {
  return outcomes.reduce((state, outcome) => {
    const r2 = outcome.runs.find((entry) => entry.repeat === "r2");
    const r3 = outcome.runs.find((entry) => entry.repeat === "r3");
    return r2 && r3 ? addPair(state, { a: primaryOf(run, r2), b: primaryOf(run, r3) }, run.pinned.target.metric.noise) : state;
  }, noise);
}

async function runRound(run: Run, state: LoopState, round: number): Promise<LoopState> {
  const ops = await planRound(run, state, round);
  const queue = await nextQueue(run, state, ops, round);
  const picks = await pick(run, queue, state, round);
  const ideas = new Map([...state.ideas, ...queue.map((idea) => [idea.id, idea] as const)]);
  const rc = roundContext(run, state, round);
  const moved = await ratchet(run, { ...state, ideas }, await fanOut(run, rc, picks, round), round);
  const picked = new Set(picks.map((idea) => idea.id));
  const sigma = rc.band.sigma;
  const outcomes = moved.outcomes.map((outcome) => ({ ...outcome, sigma }));
  const registries = outcomes.reduce((acc, outcome) => recordOutcome(acc, ideas.get(outcome.ideaId)!, outcome), recordAnalysis(state.registries, ops.analysis));
  return {
    best: moved.best,
    noise: withPairs(state.noise, outcomes, run),
    queue: [...queue.filter((idea) => !picked.has(idea.id)), ...moved.requeue],
    ideas,
    outcomes: [...state.outcomes, ...outcomes],
    evidence: [...state.evidence, ...outcomes.map((outcome) => evidenceRow(round, outcome))],
    registries,
    keptLastRound: moved.kept,
    roundsWithoutGain: moved.kept.length > 0 ? 0 : state.roundsWithoutGain + 1,
  };
}

function stopped(run: Run, state: LoopState): boolean {
  const { stop } = phaseOf(run);
  const evaluated = state.outcomes.filter((outcome) => outcome.reason !== "superseded").length;
  return evaluated >= stop.ideasEvaluated || state.roundsWithoutGain >= stop.roundsWithoutGain;
}

/** The workflow function; a host registers it under `AUTORESEARCH_WORKFLOW` with routes for every dispatch step. */
export async function runAutoresearch(ctx: WorkflowContext): Promise<void> {
  const { pin, settings } = runParams(ctx);
  const pinned = await step(ctx, arStepId("pin"), { runId: ctx.runId, pin }, PinnedSchema);
  const run: Run = { ctx, pinned, settings, keep: pinned.target.metric, result: resultSchemaFor(pinned.target.metric) };
  let state: LoopState = { ...(await baseline(run)), queue: [], ideas: new Map(), outcomes: [], evidence: [], registries: EMPTY_REGISTRIES, keptLastRound: [], roundsWithoutGain: 0 };
  for (let round = 1; round <= settings.rounds && !stopped(run, state); round++) state = await runRound(run, state, round);
}
