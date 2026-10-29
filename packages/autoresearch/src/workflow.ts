/**
 * The autoresearch recipe: pin, baseline, then rounds of plan, select and a pipelined ladder per idea,
 * with the strongest winner moving the ratchet. Everything outside the run goes through `ArPorts`.
 *
 * Inspired by Andrej Karpathy's autoresearch, https://github.com/karpathy/autoresearch (MIT); no code copied.
 */
import { mapItems, type WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { buildDigest, evidenceRow, type EvidenceRow } from "./digest.js";
import { median, type KeepSettings } from "./keep.js";
import { ideaLadder, LaneSlots, runKey, runPinOf, type ForkAssignment, type RoundContext } from "./ladder.js";
import { arStepId } from "./manifest.js";
import { addPair, band, NO_NOISE, sigmaOf, type NoiseState } from "./noise.js";
import {
  ArchivedSchema,
  InboxSchema,
  PinnedSchema,
  PlannerSchema,
  RegisteredSchema,
  RoundSummarySchema,
  StopReasonSchema,
  type Pinned,
  type Planner,
  type Reeval,
  type RegistryRow,
  type RoundRecord,
  type RoundSummary,
  type StopReason,
} from "./ports.js";
import { frozenOverlap } from "./post-check.js";
import { applyOps, quotaViolations } from "./queue.js";
import { EMPTY_REGISTRIES, recordAnalysis, recordOutcome, type Registries } from "./registry.js";
import { IdeaSchema, OutcomeSchema, QueueOpsSchema, resultSchemaFor, type ArResult, type Idea, type Outcome, type Proposal, type QueueOps } from "./schemas.js";
import { select } from "./select.js";
import { cutIfDue, SnapshotSettingsSchema, startSnapshots, syncOpen, withKept, type SnapshotRun, type SnapshotState } from "./snapshot.js";
import { dispatch, recorded, step } from "./steps.js";
import { settleWinners, type Moved } from "./winners.js";

export const AUTORESEARCH_WORKFLOW = "autoresearch";

/** Plan 4.5: after a KEEP, this many follow-ups of the winner resume its implementer; every `basinEvery`th round all lanes explore. */
export const ForkScheduleSchema = z.object({
  afterKeep: z.object({ exploit: z.number().int().nonnegative().default(1) }).default({ exploit: 1 }),
  basinEvery: z.number().int().positive().default(3),
});

export const RunSettingsSchema = z.object({
  lanes: z.number().int().positive().default(3),
  rounds: z.number().int().positive().default(50),
  minPool: z.number().int().nonnegative().default(12),
  /** Names of the target's cases; a proposal that mentions one is refused before any spawn. */
  caseNames: z.array(z.string()).default([]),
  forkSchedule: ForkScheduleSchema.default({ afterKeep: { exploit: 1 }, basinEvery: 3 }),
  /** Set by a host with snapshot and sync ports; absent, the run never cuts, and a run recorded before cadence replays unchanged. */
  snapshot: SnapshotSettingsSchema.optional(),
});
export type RunSettings = z.infer<typeof RunSettingsSchema>;
type Spend = RegistryRow["spend"];
type DispatchUsage = NonNullable<Planner["usage"]>;

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
  /** How far the owner inbox has been read; only a recorded `ar-inbox` answer moves it. */
  inboxCursor: number;
  spend: Spend;
  archives: string[];
  snapshot: SnapshotState;
}

const phaseOf = (run: Run) => run.pinned.target.phases[0]!;
const primaryOf = (run: Run, result: ArResult) => result.metrics[run.keep.primary.name]!;

function runParams(ctx: WorkflowContext): { pin: string; settings: RunSettings } {
  const pin = ctx.param("pin");
  if (!pin) throw new Error(`${AUTORESEARCH_WORKFLOW}: param pin is required`);
  return { pin, settings: RunSettingsSchema.parse(JSON.parse(ctx.param("config") ?? "{}")) };
}

/** Iteration 0: duplicate runs of the starting head give B and the first σ pairs. */
async function baseline(run: Run): Promise<Pick<LoopState, "best" | "noise" | "spend">> {
  const { ctx, pinned } = run;
  const keys = Array.from({ length: phaseOf(run).baselineRuns }, (_, index) => `b${index + 1}`);
  const input = (label: string) => ({ ...runPinOf(run), tree: pinned.integrationTree, case: phaseOf(run).train[0], key: runKey(ctx.runId, "base", label), rung: "seed" });
  const evalBase = (label: string) => dispatch(ctx, `${arStepId("eval")}:base:${label}`, input(label), run.result);
  const mapped = await mapItems(ctx, "ar-baseline", keys, (key) => evalBase(key), { key: (key) => key, concurrency: 2 });
  if (mapped.failed.length > 0 || mapped.skipped.length > 0) throw new Error(`[baseline] ${mapped.failed.map((failure) => `${failure.key}: ${failure.error}`).join("; ")}`);
  const runs = mapped.results.map(({ result }) => z.object({ result: run.result }).parse(result.data).result);
  let noise = NO_NOISE;
  for (let index = 0; index + 1 < runs.length; index += 2) {
    noise = addPair(noise, { a: primaryOf(run, runs[index]!), b: primaryOf(run, runs[index + 1]!) }, pinned.target.metric.noise);
  }
  return { best: { head: pinned.ratchetHead, runs }, noise, spend: { ...NO_SPEND, modelUsd: sum(runs.map((result) => result.usd)) } };
}

const NO_SPEND: Spend = { agentUsd: 0, modelUsd: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/**
 * Agent dollars are implementers and planners; model dollars are eval and micro runs, a re-evaluation's runs among
 * them, which no outcome carries. Superseded outcomes spent too.
 */
export function addSpend(spend: Spend, outcomes: readonly Outcome[], planners: readonly DispatchUsage[], reevals: readonly Reeval[]): Spend {
  const reevalUsd = sum(reevals.flatMap((reeval) => reeval.runs.map((result) => result.usd)));
  return {
    agentUsd: spend.agentUsd + sum(outcomes.map((outcome) => outcome.usage?.implementUsd ?? 0)) + sum(planners.map((usage) => usage.usd)),
    modelUsd: spend.modelUsd + sum(outcomes.map((outcome) => (outcome.usage?.evalUsd ?? 0) + (outcome.usage?.microUsd ?? 0))) + reevalUsd,
    cacheReadTokens: spend.cacheReadTokens + sum(planners.map((usage) => usage.cacheReadTokens ?? 0)),
    cacheWriteTokens: spend.cacheWriteTokens + sum(planners.map((usage) => (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0))),
  };
}

const PlanStepSchema = PlannerSchema.partial().extend({ ops: QueueOpsSchema });

/** Only a planner that named itself is recorded; its other fields mean nothing without the agent. */
function plannerOf({ ops: _ops, ...planned }: z.infer<typeof PlanStepSchema>): Planner | undefined {
  return planned.agent === undefined ? undefined : { ...planned, agent: planned.agent };
}

interface PlannedRound {
  ops: QueueOps;
  planner?: Planner;
  /** The first attempt's quota misses, which a retry's clean answer would otherwise hide. */
  violations: string[];
  retried: boolean;
  usage: DispatchUsage[];
}

/** The planner gets one retry that names the quota it missed; a second miss stops the run. */
async function planRound(run: Run, state: LoopState, round: number): Promise<PlannedRound> {
  const digest = buildDigest({ round, evidence: state.evidence, registries: state.registries, queue: state.queue });
  const quota = { keptLastRound: state.keptLastRound, minPool: run.settings.minPool, queuedBefore: state.queue.length };
  let violations: string[] = [];
  let first: string[] | undefined;
  const usage: DispatchUsage[] = [];
  for (const attempt of ["", ".retry"]) {
    const input = { runId: run.ctx.runId, round, digest, violations, mode: round === 1 ? "spawn" : "resume" };
    const planned = await step(run.ctx, `${arStepId("plan")}:${round}${attempt}`, input, PlanStepSchema);
    if (planned.usage) usage.push(planned.usage);
    violations = quotaViolations(planned.ops, quota);
    first ??= violations;
    if (violations.length === 0) return { ops: planned.ops, planner: plannerOf(planned), violations: first, retried: attempt !== "", usage };
  }
  throw new Error(`[planner-quota] round ${round}: ${violations.join("; ")}`);
}

/** Owner proposals written since the last round; the answer is recorded, so a replay reads the same ideas whatever the inbox holds now. */
async function ownerIdeas(run: Run, state: LoopState, round: number): Promise<{ ideas: Proposal[]; cursor: number }> {
  const inbox = await step(run.ctx, `${arStepId("inbox")}:${round}`, { runId: run.ctx.runId, round, after: state.inboxCursor }, InboxSchema);
  return { ideas: inbox.ideas.map((proposal) => ({ ...proposal, source: "owner" as const })), cursor: inbox.cursor };
}

/** Owner ideas go first, so a planner repeat of one is the duplicate; the planner's quotas count only its own ops. */
async function roundOps(run: Run, state: LoopState, round: number): Promise<{ ops: QueueOps; planned: PlannedRound; cursor: number }> {
  const inbox = await ownerIdeas(run, state, round);
  const planned = await planRound(run, state, round);
  return { ops: { ...planned.ops, add: [...inbox.ideas, ...planned.ops.add] }, planned, cursor: inbox.cursor };
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

interface Settled {
  sigma: number;
  superseded: readonly string[];
  /** Absent for a round recorded before concurrent winners. */
  reevals?: readonly Reeval[];
}

function settle(outcome: Outcome, superseded: boolean, reeval: Reeval | undefined): Outcome {
  const verdict = reeval && { reeval: { vs: reeval.vs, decision: reeval.decision, reason: reeval.reason } };
  if (superseded) return { ...outcome, verdict: "stopped", reason: "superseded", ...verdict };
  if (reeval?.decision === "rejected") return { ...outcome, verdict: "rejected", reason: `reeval:${reeval.reason}`, ...verdict };
  return { ...outcome, ...verdict };
}

/**
 * The outcomes a round settles on: each requeued winner stopped as superseded, each winner the new head rejected
 * rejected, every re-evaluated one carrying its `reeval`, and every outcome stamped with the round's σ.
 * The recipe and any reader of the recorded stops share it, so they cannot disagree.
 */
export function finalOutcomes(stops: readonly Outcome[], { sigma, superseded, reevals = [] }: Settled): Outcome[] {
  const marked = new Set(superseded);
  const reevalOf = new Map(reevals.map((reeval) => [reeval.ideaId, reeval]));
  return stops.map((outcome) => ({ ...settle(outcome, marked.has(outcome.ideaId), reevalOf.get(outcome.ideaId)), sigma }));
}

/** The net move: from where the round's first move started to where its last one ended. */
function netMove(moves: Moved["moves"]): RoundSummary["ratchet"] {
  return moves.length === 0 ? null : { from: moves[0]!.from, to: moves.at(-1)!.to };
}

/** G7 and G16, recorded once the ratchet has moved, so a reader sees the round's decision rather than redoing it. */
async function summarize(run: Run, round: number, rc: RoundContext, planned: PlannedRound, moved: Moved): Promise<RoundSummary> {
  const best = { head: moved.best.head, primary: median(moved.best.runs.map((result) => primaryOf(run, result))) };
  const decided = { keptIds: moved.kept, superseded: moved.superseded, ratchet: netMove(moved.moves), moves: moved.moves, reevals: moved.reevals };
  const summary = { round, best, against: rc.against, ...decided, quotaViolations: planned.violations, plannerRetried: planned.retried };
  return recorded(run.ctx, `${arStepId("summary")}:${round}`, RoundSummarySchema, () => summary);
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
async function archive(run: Run, round: number, record: RoundRecord): Promise<string | undefined> {
  return (await step(run.ctx, `${arStepId("archive")}:${round}`, { runId: run.ctx.runId, round, record }, ArchivedSchema)).path;
}

function unpicked(queue: readonly Idea[], picks: readonly Idea[]): Idea[] {
  const picked = new Set(picks.map((idea) => idea.id));
  return queue.filter((idea) => !picked.has(idea.id));
}

async function runRound(run: Run, state: LoopState, round: number): Promise<LoopState> {
  const { ops, planned, cursor } = await roundOps(run, state, round);
  const queue = await nextQueue(run, state, ops, round);
  const { picks, draws } = await pick(run, queue, state, round);
  const ideas = new Map([...state.ideas, ...queue.map((idea) => [idea.id, idea] as const)]);
  const rc = roundContext(run, state, round, picks);
  const sigma = rc.band.sigma;
  const stops = await fanOut(run, rc, picks, round);
  const moved = await settleWinners(rc, ideas, stops);
  await summarize(run, round, rc, planned, moved);
  const outcomes = finalOutcomes(stops, { sigma, superseded: moved.superseded, reevals: moved.reevals });
  const registries = outcomes.reduce((acc, outcome) => recordOutcome(acc, ideas.get(outcome.ideaId)!, outcome, round), recordAnalysis(state.registries, ops.analysis, round));
  const evidence = outcomes.map((outcome) => evidenceRow(round, outcome));
  const archived = await archive(run, round, { outcomes, digest: rc.digest, ops, draws, registries, evidence, ...(planned.planner ? { planner: planned.planner } : {}) });
  return {
    best: moved.best,
    noise: withPairs(state.noise, outcomes, run),
    queue: [...unpicked(queue, picks), ...moved.requeue],
    ideas,
    outcomes: [...state.outcomes, ...outcomes],
    evidence: [...state.evidence, ...evidence],
    registries,
    keptLastRound: moved.kept,
    roundsWithoutGain: moved.kept.length > 0 ? 0 : state.roundsWithoutGain + 1,
    inboxCursor: cursor,
    spend: addSpend(state.spend, outcomes, planned.usage, moved.reevals),
    archives: archived === undefined ? state.archives : [...state.archives, archived],
    snapshot: withKept(state.snapshot, outcomes, moved.kept),
  };
}

const snapshotRun = (run: Run): SnapshotRun | null => (run.settings.snapshot ? { ...run, settings: run.settings.snapshot } : null);

/** With snapshots on, an open snapshot is synced before the round plans, and the cadence is checked once it is archived. */
async function cadencedRound(run: Run, state: LoopState, round: number): Promise<LoopState> {
  const snapshots = snapshotRun(run);
  if (!snapshots) return runRound(run, state, round);
  const synced = await syncOpen(snapshots, state, round);
  return cutIfDue(snapshots, await runRound(run, synced, round), round);
}

/** The run ends with any due cut made, or pending behind the open one; it never waits for review. */
async function finalCut(run: Run, state: LoopState, stopReason: StopReason): Promise<LoopState> {
  const snapshots = snapshotRun(run);
  if (!snapshots) return state;
  return cutIfDue(snapshots, await syncOpen(snapshots, state, "end"), "end", stopReason);
}

/** A superseded winner goes back in the queue, so it is evaluated when it runs again, not twice. */
const evaluatedOf = (outcomes: readonly Outcome[]) => outcomes.filter((outcome) => outcome.reason !== "superseded");

function stopped(run: Run, state: LoopState): Exclude<StopReason, "rounds-exhausted"> | null {
  const { stop } = phaseOf(run);
  if (evaluatedOf(state.outcomes).length >= stop.ideasEvaluated) return "ideas-evaluated";
  return state.roundsWithoutGain >= stop.roundsWithoutGain ? "rounds-without-gain" : null;
}

const REGISTRY_PROVENANCE = "frozen evaluator gates; validator looks recorded separately, never read by the search";

/** G17: the phase's registry row. Cases appear only as the phase's own train aliases. */
function registryRow(run: Run, state: LoopState, stopReason: StopReason): RegistryRow {
  const { pinned } = run;
  const phase = phaseOf(run);
  const ideasByRung: Record<string, number> = {};
  for (const { rungReached } of evaluatedOf(state.outcomes)) ideasByRung[rungReached] = (ideasByRung[rungReached] ?? 0) + 1;
  const noise = pinned.target.metric.noise;
  const sigma = sigmaOf(state.noise) ?? band(state.noise, noise) / noise.bandSigmas;
  const noiseRow = { sigma, pairs: state.noise.pairs.length, locked: state.noise.locked !== undefined };
  const shas = { targetSha: pinned.targetSha, boundsSha: pinned.boundsSha };
  return { phase: phase.id, pin: pinned.pin, ...shas, trainCases: phase.train, ideasByRung, ...noiseRow, spend: state.spend, archives: state.archives, stopReason, provenance: REGISTRY_PROVENANCE };
}

/** Why the loop ended, recorded, then the phase's registry row; a run that threw has neither, and its error code says why. */
async function finish(run: Run, state: LoopState): Promise<void> {
  const { ctx } = run;
  const reason: StopReason = stopped(run, state) ?? "rounds-exhausted";
  const { stopReason } = await recorded(ctx, arStepId("end"), EndSchema, () => ({ stopReason: reason }));
  const final = await finalCut(run, state, stopReason);
  await step(ctx, `${arStepId("registry")}:${phaseOf(run).id}`, { runId: ctx.runId, row: registryRow(run, final, stopReason) }, RegisteredSchema);
}

const EndSchema = z.object({ stopReason: StopReasonSchema });

/** The workflow function; a host registers it under `AUTORESEARCH_WORKFLOW` with routes for every dispatch step. */
export async function runAutoresearch(ctx: WorkflowContext): Promise<void> {
  const { pin, settings } = runParams(ctx);
  const pinned = await step(ctx, arStepId("pin"), { runId: ctx.runId, pin }, PinnedSchema);
  const overlap = frozenOverlap(pinned.bounds, pinned.target.frozen);
  if (overlap.length > 0) throw new Error(`[bounds-frozen] ${overlap.join(", ")}`);
  const run: Run = { ctx, pinned, settings, keep: pinned.target.metric, result: resultSchemaFor(pinned.target.metric) };
  const empty = { queue: [], ideas: new Map(), outcomes: [], evidence: [], registries: EMPTY_REGISTRIES, keptLastRound: [], roundsWithoutGain: 0, inboxCursor: 0, archives: [] };
  let state: LoopState = { ...empty, snapshot: startSnapshots(pinned.ratchetHead), ...(await baseline(run)) };
  for (let round = 1; round <= settings.rounds && !stopped(run, state); round++) state = await cadencedRound(run, state, round);
  await finish(run, state);
}
