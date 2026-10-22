/**
 * The autoresearch recipe: pin, baseline, then rounds of plan, select and a pipelined ladder per idea,
 * with the strongest winner moving the ratchet. Everything outside the run goes through `ArPorts`.
 *
 * Inspired by Andrej Karpathy's autoresearch, https://github.com/karpathy/autoresearch (MIT); no code copied.
 */
import { createHash } from "node:crypto";
import { canonicalArgs } from "@titan-design/rpc-client";
import { mapItems, type WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { buildDigest, evidenceRow, type EvidenceRow } from "./digest.js";
import type { KeepSettings } from "./keep.js";
import { ideaLadder, LaneSlots, runKey, type ForkAssignment, type RoundContext } from "./ladder.js";
import { arStepId } from "./manifest.js";
import { addPair, band, NO_NOISE, sigmaOf, type NoiseState } from "./noise.js";
import { ArchivedSchema, HeadSchema, PinnedSchema, type Pinned, type RatchetRequest, type RoundRecord } from "./ports.js";
import { frozenOverlap } from "./post-check.js";
import { applyOps, quotaViolations } from "./queue.js";
import { EMPTY_REGISTRIES, recordAnalysis, recordOutcome, type Registries } from "./registry.js";
import { IdeaSchema, OutcomeSchema, QueueOpsSchema, resultSchemaFor, type ArResult, type Idea, type Outcome, type QueueOps } from "./schemas.js";
import { select } from "./select.js";
import { dispatch, recorded, step } from "./steps.js";

export const AUTORESEARCH_WORKFLOW = "autoresearch";

/** Plan 4.5: after a KEEP, this many follow-ups of the winner resume its implementer; every `basinEvery`th round all lanes explore. */
const ForkScheduleSchema = z.object({
  afterKeep: z.object({ exploit: z.number().int().nonnegative().default(1) }).default({ exploit: 1 }),
  basinEvery: z.number().int().positive().default(3),
});

const RunSettingsSchema = z.object({
  lanes: z.number().int().positive().default(3),
  rounds: z.number().int().positive().default(50),
  minPool: z.number().int().nonnegative().default(12),
  /** Names of the target's cases; a proposal that mentions one is refused before any spawn. */
  caseNames: z.array(z.string()).default([]),
  forkSchedule: ForkScheduleSchema.default({ afterKeep: { exploit: 1 }, basinEvery: 3 }),
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
  const input = (label: string) => ({ tree: pinned.integrationTree, case: phaseOf(run).train[0], key: runKey(ctx.runId, "base", label), rung: "seed" });
  const evalBase = (label: string) => dispatch(ctx, `${arStepId("eval")}:base:${label}`, input(label), run.result);
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
    const input = { runId: run.ctx.runId, round, digest, violations, mode: round === 1 ? "spawn" : "resume" };
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

const SelectionSchema = z.object({ picks: z.array(IdeaSchema), draws: z.array(z.object({ id: z.string(), draw: z.number() })), plannerTopK: z.array(z.string()) });

async function pick(run: Run, queue: readonly Idea[], state: LoopState, round: number): Promise<z.infer<typeof SelectionSchema>> {
  return recorded(run.ctx, `${arStepId("select")}:${round}`, SelectionSchema, () => select(queue, state.outcomes, { runId: run.ctx.runId, round, k: 2 * run.settings.lanes }));
}

/**
 * Plan 4.5's fixed schedule: after a KEEP, the winner's follow-ups (up to `afterKeep.exploit`) resume its implementer;
 * every other pick, and every pick in a basin-escape round, is a fresh explore spawn.
 */
export function forkPlan(picks: readonly Idea[], round: number, winners: ReadonlyMap<string, string>, schedule: RunSettings["forkSchedule"]): Map<string, ForkAssignment> {
  const plan = new Map<string, ForkAssignment>(picks.map((idea) => [idea.id, { fork: "explore" }]));
  if (round % schedule.basinEvery === 0) return plan;
  const followups = picks.filter((idea) => idea.parent !== undefined && winners.has(idea.parent));
  for (const idea of followups.slice(0, schedule.afterKeep.exploit)) plan.set(idea.id, { fork: "exploit", resumeFrom: winners.get(idea.parent!)! });
  return plan;
}

/** Last round's winners and the agent that wrote each, for the exploit lanes. */
function winnerAgents(state: LoopState): Map<string, string> {
  const kept = state.outcomes.filter((outcome) => state.keptLastRound.includes(outcome.ideaId) && outcome.implementer);
  return new Map(kept.map((outcome) => [outcome.ideaId, outcome.implementer!.agent]));
}

function roundContext(run: Run, state: LoopState, round: number, picks: readonly Idea[]): RoundContext {
  const noise = run.pinned.target.metric.noise;
  const width = band(state.noise, noise);
  const sigma = sigmaOf(state.noise) ?? width / noise.bandSigmas;
  const digest = buildDigest({ round, evidence: state.evidence, registries: state.registries, queue: state.queue });
  const testCase = phaseOf(run).train[0]!;
  const against = { case: testCase, head: state.best.head, bandWidth: width, sigma, pairs: state.noise.pairs.length, locked: state.noise.locked !== undefined };
  const forks = forkPlan(picks, round, winnerAgents(state), run.settings.forkSchedule);
  return { ctx: run.ctx, pinned: run.pinned, case: testCase, result: run.result, best: state.best, band: { width, sigma }, keep: run.keep, digest, round, against, forks, slots: new LaneSlots() };
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
const smaller = (a: Outcome, b: Outcome) =>
  (a.diff?.srcLines ?? Infinity) - (b.diff?.srcLines ?? Infinity) || (a.diff?.srcFiles ?? Infinity) - (b.diff?.srcFiles ?? Infinity) || a.ideaId.localeCompare(b.ideaId);

/**
 * Winners within σ of the strongest are a tie, and the smallest source diff of those goes first; the rest
 * stay in Δ order. A pick over a fixed set, not a tolerance comparator, which would not be transitive.
 */
export function pickWinner(winners: readonly Outcome[], sigma: number): Outcome[] {
  if (winners.length === 0) return [];
  const top = Math.max(...winners.map((outcome) => outcome.delta ?? 0));
  const [first] = winners.filter((outcome) => (outcome.delta ?? 0) >= top - sigma).sort(smaller);
  return [first!, ...[...winners].sort(byStrength).filter((outcome) => outcome !== first)];
}

const runDigest = (result: ArResult) => createHash("sha256").update(canonicalArgs(result)).digest("hex");

/** The G12 move record: which idea moved the ratchet, on what evidence, against which pin. */
function ratchetMove(run: Run, state: LoopState, first: Outcome, round: number, sigma: number): RatchetRequest {
  const { ratchetRef, integrationTree: tree, target, pin } = run.pinned;
  const evidence = { round, ideaId: first.ideaId, kind: "ff" as const, keepRung: first.rungReached, delta: first.delta ?? 0, sigma, runDigests: first.runs.map(runDigest), pin };
  return { tree, ratchetRef, ratchetPrefix: target.ratchetPrefix, from: state.best.head, to: first.head!, ...evidence };
}

/** The picked winner moves the ratchet; any other winner goes back in the queue on its lineage until S5 re-evaluates it against the new head. */
async function ratchet(run: Run, state: LoopState, outcomes: Outcome[], round: number, sigma: number) {
  const winners = pickWinner(outcomes.filter((outcome) => outcome.verdict === "kept"), sigma);
  const [first, ...rest] = winners;
  if (!first) return { best: state.best, kept: [], outcomes, requeue: [] };
  const move = ratchetMove(run, state, first, round, sigma);
  const { head } = await step(run.ctx, `${arStepId("ratchet")}:${round}`, move, HeadSchema);
  const superseded = new Set(rest.map((outcome) => outcome.ideaId));
  const marked = outcomes.map((outcome) => (superseded.has(outcome.ideaId) ? { ...outcome, verdict: "stopped" as const, reason: "superseded" } : outcome));
  const requeue = rest.map((outcome) => ({ ...state.ideas.get(outcome.ideaId)!, source: "requeue" as const, round: round + 1 }));
  return { best: { head, runs: first.runs }, kept: [first.ideaId], outcomes: marked, requeue };
}

/**
 * L3's repeats r2 and r3 (`runs[1]`, `runs[2]`) are two runs of the same code on the same case: a free σ pair.
 * Matched by position, since a target echoes the unique run key as `repeat`.
 */
function withPairs(noise: NoiseState, outcomes: readonly Outcome[], run: Run): NoiseState {
  return outcomes.reduce((state, outcome) => {
    const [, r2, r3] = outcome.runs;
    return outcome.rungReached === "L3" && r2 && r3 ? addPair(state, { a: primaryOf(run, r2), b: primaryOf(run, r3) }, run.pinned.target.metric.noise) : state;
  }, noise);
}

/** G11: the round's record goes to the host's archive once the ratchet has moved. */
async function archive(run: Run, round: number, record: RoundRecord): Promise<void> {
  await step(run.ctx, `${arStepId("archive")}:${round}`, { runId: run.ctx.runId, round, record }, ArchivedSchema);
}

async function runRound(run: Run, state: LoopState, round: number): Promise<LoopState> {
  const ops = await planRound(run, state, round);
  const queue = await nextQueue(run, state, ops, round);
  const { picks, draws } = await pick(run, queue, state, round);
  const ideas = new Map([...state.ideas, ...queue.map((idea) => [idea.id, idea] as const)]);
  const rc = roundContext(run, state, round, picks);
  const sigma = rc.band.sigma;
  const moved = await ratchet(run, { ...state, ideas }, await fanOut(run, rc, picks, round), round, sigma);
  const picked = new Set(picks.map((idea) => idea.id));
  const outcomes = moved.outcomes.map((outcome) => ({ ...outcome, sigma }));
  const registries = outcomes.reduce((acc, outcome) => recordOutcome(acc, ideas.get(outcome.ideaId)!, outcome, round), recordAnalysis(state.registries, ops.analysis, round));
  const evidence = outcomes.map((outcome) => evidenceRow(round, outcome));
  await archive(run, round, { outcomes, digest: rc.digest, ops, draws, registries, evidence });
  return {
    best: moved.best,
    noise: withPairs(state.noise, outcomes, run),
    queue: [...queue.filter((idea) => !picked.has(idea.id)), ...moved.requeue],
    ideas,
    outcomes: [...state.outcomes, ...outcomes],
    evidence: [...state.evidence, ...evidence],
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
  const overlap = frozenOverlap(pinned.bounds, pinned.target.frozen);
  if (overlap.length > 0) throw new Error(`[bounds-frozen] ${overlap.join(", ")}`);
  const run: Run = { ctx, pinned, settings, keep: pinned.target.metric, result: resultSchemaFor(pinned.target.metric) };
  let state: LoopState = { ...(await baseline(run)), queue: [], ideas: new Map(), outcomes: [], evidence: [], registries: EMPTY_REGISTRIES, keptLastRound: [], roundsWithoutGain: 0 };
  for (let round = 1; round <= settings.rounds && !stopped(run, state); round++) state = await runRound(run, state, round);
}
