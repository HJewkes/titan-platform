/**
 * G14: a run's read model, replayed from its recorded steps. It reads the step ids the recipe writes and never
 * re-decides what the recipe recorded; the one shared rule, settling a round's outcomes, is the recipe's own `finalOutcomes`.
 */
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { cellTable, evidenceRow, type EvidenceRow } from "./digest.js";
import { median } from "./keep.js";
import { arStepId } from "./manifest.js";
import {
  ImplementedSchema,
  LookAggregateSchema,
  PinnedSchema,
  PlannerSchema,
  ReevalSchema,
  RoundSummarySchema,
  SnapshotResultSchema,
  StaticCheckSchema,
  StopReasonSchema,
  SyncResultSchema,
  type CadenceRound,
  type Pinned,
  type RoundSummary,
  type SyncResult,
} from "./ports.js";
import { EMPTY_REGISTRIES, recordAnalysis, recordOutcome, type Registries } from "./registry.js";
import { ArMicroSchema, ArResultSchema, IdeaSchema, OutcomeSchema, QueueOpsSchema, type ArResult, type Idea, type MetricSpec, type Outcome } from "./schemas.js";
import { CadenceSchema, SyncGateAnswerSchema } from "./snapshot.js";
import { finalOutcomes, RunSettingsSchema } from "./workflow.js";
import type { ArEvalView, ArIdeaView, ArLadderView, ArMetricView, ArReevalView, ArRoundView, ArRunSummary, ArRunView, ArSnapshotView, ArSyncView, ArTargetView } from "./read-model-types.js";

type Steps = ReadonlyMap<string, StepResult>;

const indexSteps = (run: WorkflowRun): Steps => new Map(Object.values(run.stepResults).map((result) => [result.stepId, result]));

function dispatched<T>(steps: Steps, stepId: string, schema: z.ZodType<T>): T | undefined {
  const result = steps.get(stepId);
  return result ? z.object({ result: schema }).parse(result.data).result : undefined;
}

function seeded<T>(steps: Steps, stepId: string, schema: z.ZodType<T>): T | undefined {
  const output = steps.get(stepId)?.output;
  return output === undefined ? undefined : schema.parse(JSON.parse(output));
}

/** The console names gates and the no-op metric as lists, and the band in pp; everything else keeps the engine's shape. */
export function projectMetric(metric: MetricSpec, baseline: readonly ArResult[]): ArMetricView {
  const { bandSigmas, lockAfterPairs, minPairs, defaultBand } = metric.noise;
  const gates = [...new Set(baseline.flatMap((run) => Object.keys(run.gates)))].sort();
  return {
    primary: metric.primary.name,
    direction: metric.primary.direction,
    guards: Object.keys(metric.guards),
    zeroTolerance: metric.zeroTolerance,
    allGate: metric.allGate ? gates : [],
    noOp: metric.noOp ? [metric.noOp] : [],
    noise: { bandSigmas, lockAfterPairs, minPairs, defaultBandPp: defaultBand },
  };
}

const projectRun = ({ wall_s, ...run }: ArResult): ArEvalView => ({ ...run, wallS: wall_s });

const BASELINE = /^ar-eval:base:b(\d+)$/;

function baselineRuns(steps: Steps): ArResult[] {
  const labelled = [...steps.keys()].flatMap((stepId) => {
    const label = BASELINE.exec(stepId)?.[1];
    return label === undefined ? [] : [{ stepId, n: Number(label) }];
  });
  return labelled.sort((a, b) => a.n - b.n).map(({ stepId }) => dispatched(steps, stepId, ArResultSchema)!);
}

const summaryOf = (steps: Steps, round: number) => seeded(steps, `${arStepId("summary")}:${round}`, RoundSummarySchema);

function lastSummary(steps: Steps): RoundSummary | undefined {
  let last: RoundSummary | undefined;
  for (let round = 1, summary = summaryOf(steps, 1); summary; summary = summaryOf(steps, ++round)) last = summary;
  return last;
}

/** The best so far: the last round's recorded best, else the starting head at the baseline median. */
function bestOf(steps: Steps, pinned: Pinned, baseline: readonly ArResult[]) {
  const primary = pinned.target.metric.primary.name;
  const b0 = baseline.length === 0 ? 0 : median(baseline.map((run) => run.metrics[primary]!));
  return { b0, best: lastSummary(steps)?.best ?? { head: pinned.ratchetHead, primary: b0 } };
}

const settingsOf = (run: WorkflowRun) => RunSettingsSchema.parse(JSON.parse(run.params.config ?? "{}"));

/** A run started before the factory named its target reads as its ratchet prefix. */
const targetName = (run: WorkflowRun, pinned: Pinned | undefined) => run.params.target ?? pinned?.target.ratchetPrefix ?? "";

const PLAN = /^ar-plan:(\d+)(?:\.retry)?$/;

/** The highest round whose planner has answered or is running; 0 before round 1. */
function currentRound(run: WorkflowRun): number {
  const stepIds = [...Object.values(run.stepResults), ...Object.values(run.activeSteps)].map((step) => step.stepId);
  return Math.max(0, ...stepIds.map((stepId) => Number(PLAN.exec(stepId)?.[1] ?? 0)));
}

/** Every step's recorded cost, failed attempts included, plus what in-flight steps already spent on attempts that failed. */
function spendOf(run: WorkflowRun): number {
  const done = Object.values(run.stepResults).reduce((sum, result) => sum + (result.usage?.costUsd ?? 0), 0);
  return Object.values(run.activeSteps).reduce((sum, active) => sum + (active.priorUsage?.costUsd ?? 0), done);
}

const pinnedOf = (steps: Steps) => dispatched(steps, arStepId("pin"), PinnedSchema);

/** One row of `autoresearch.runs`; `best` stays null until every baseline eval is recorded. */
export function arRunSummary(run: WorkflowRun): ArRunSummary {
  const steps = indexSteps(run);
  const pinned = pinnedOf(steps);
  const phase = pinned?.target.phases[0];
  const baseline = baselineRuns(steps);
  const best = pinned && phase && baseline.length >= phase.baselineRuns ? bestOf(steps, pinned, baseline).best : null;
  const { id: runId, status, startedAt, completedAt } = run;
  const { open } = snapshotTimeline(steps);
  const openSnapshot = open && { k: open.k, pr: open.pr };
  const progress = { phase: phase?.id ?? "", round: currentRound(run), rounds: settingsOf(run).rounds };
  return { runId, target: targetName(run, pinned), ...progress, status, startedAt, completedAt, best, spend: spendOf(run), openSnapshot };
}

const inScope = (stepId: string, scope: string) => stepId.split(":")[1] === scope;

function activeIn(run: WorkflowRun, scope: string) {
  const active = Object.values(run.activeSteps).find((step) => inScope(step.stepId, scope));
  return active ? { stepId: active.stepId, firstStartedAt: active.firstStartedAt ?? active.startedAt, restarts: active.restarts ?? 0 } : null;
}

const EVAL_PREFIX = `${arStepId("eval")}:`;

function evalsIn(steps: Steps, scope: string) {
  const stepIds = [...steps.keys()].filter((stepId) => stepId.startsWith(`${EVAL_PREFIX}${scope}:`));
  return stepIds.map((stepId) => projectRun(dispatched(steps, stepId, ArResultSchema)!));
}

const TIMELINE = /^ar-(?:cadence|sync):(\d+|end)$/;

/** Every round a sync or a cadence was recorded for, in run order: numbered rounds, then `end`. */
function timelineRounds(steps: Steps): CadenceRound[] {
  const labels = new Set([...steps.keys()].flatMap((stepId) => TIMELINE.exec(stepId)?.[1] ?? []));
  const numbered = [...labels].filter((label) => label !== "end").map(Number).sort((a, b) => a - b);
  return labels.has("end") ? [...numbered, "end"] : numbered;
}

/** The cut a round's cadence made, if it was due, unblocked and its snapshot step answered; `k` is the next cut's number. */
function cutAt(steps: Steps, round: CadenceRound, k: number): ArSnapshotView | undefined {
  const cadence = arStepId("cadence");
  const decided = seeded(steps, `${cadence}:${round}`, CadenceSchema);
  if (!decided?.due || decided.blockedBy !== null || steps.has(`${cadence}:${round}.failed`)) return undefined;
  const result = dispatched(steps, `${arStepId("snapshot")}:${k}`, SnapshotResultSchema);
  if (!result || "failed" in result) return undefined;
  const { tag, sha, branch, pr, url, logSha } = result;
  return { k: result.k, tag, sha, branch, pr, ...(url === undefined ? {} : { url }), trigger: decided.trigger!, round, logSha };
}

const holds = (result: SyncResult) => result.conflict !== undefined || result.frozen !== undefined;

/** The owner's answer to a held sync; the recipe opens no gate for the run's last sync. */
function gateOf(steps: Steps, round: CadenceRound, held: SyncResult): Pick<ArSyncView, "gate"> {
  if (!holds(held) || round === "end") return {};
  const answer = steps.get(`${arStepId("sync-gate")}:${round}`);
  if (!answer) return { gate: { answered: false } };
  const parsed = SyncGateAnswerSchema.safeParse(answer.data);
  return { gate: { answered: true, ...(parsed.success ? { resolved: parsed.data.resolved } : {}) } };
}

/** A round's sync of the open PR: where it settled, why a gate held it, and B's re-measure when main changed the tree. */
function syncAt(steps: Steps, round: CadenceRound, pr: number): { view: ArSyncView; settled: SyncResult } | undefined {
  const stepId = `${arStepId("sync")}:${round}`;
  const held = dispatched(steps, stepId, SyncResultSchema);
  if (!held) return undefined;
  const settled = dispatched(steps, `${stepId}.resolved`, SyncResultSchema) ?? held;
  const runs = evalsIn(steps, `sync-${round}`);
  return { view: { round, pr, ...held, ...settled, ...gateOf(steps, round, held), ...(runs.length > 0 ? { runs } : {}) }, settled };
}

/** Cuts and syncs replayed in run order: each round syncs the open PR before its cadence may cut the next. */
function snapshotTimeline(steps: Steps) {
  const snapshots: ArSnapshotView[] = [];
  const syncs: ArSyncView[] = [];
  let open: ArSnapshotView | null = null;
  for (const round of timelineRounds(steps)) {
    const synced = open && syncAt(steps, round, open.pr);
    if (synced) syncs.push(synced.view);
    if (synced && synced.settled.state !== "open" && !holds(synced.settled)) open = null;
    const cut = cutAt(steps, round, snapshots.length + 1);
    if (cut) snapshots.push((open = cut));
  }
  return { snapshots, syncs, open };
}

function snapshotsOf(steps: Steps): Pick<ArRunView, "snapshots" | "snapshotPending" | "syncs"> {
  const { snapshots, syncs } = snapshotTimeline(steps);
  const end = seeded(steps, `${arStepId("cadence")}:end`, CadenceSchema);
  const snapshotPending = end?.blockedBy === "open" && end.trigger ? { trigger: end.trigger } : null;
  return { snapshots, snapshotPending, syncs };
}

/** The round's re-evaluations in the order the recipe settled them. */
function reevalsOf(steps: Steps, round: number): ArReevalView[] {
  const prefix = `${arStepId("reeval")}:${round}/`;
  const stepIds = [...steps.keys()].filter((stepId) => stepId.startsWith(prefix));
  return stepIds.map((stepId) => {
    const { runs, ...reeval } = seeded(steps, stepId, ReevalSchema)!;
    return { ...reeval, runs: runs.map(projectRun) };
  });
}

/** `implementer`, `l0`, `micro` and `outcome` are the recorded values; only the micro flag is renamed for the console. */
function ladderOf(steps: Steps, run: WorkflowRun, scope: string, idea: ArIdeaView, settle: (stop: Outcome) => Outcome): ArLadderView {
  const implemented = dispatched(steps, `${arStepId("implement")}:${scope}`, ImplementedSchema);
  const l0 = dispatched(steps, `${arStepId("l0")}:${scope}`, StaticCheckSchema);
  const micro = dispatched(steps, `${arStepId("l1")}:${scope}`, ArMicroSchema);
  const stop = seeded(steps, `${arStepId("stop")}:${scope}`, OutcomeSchema);
  const completed = [...steps.values()].filter((result) => inScope(result.stepId, scope)).map(({ stepId, completedAt }) => ({ stepId, completedAt }));
  return {
    idea,
    implementer: implemented ? { agent: implemented.agent, sessionId: implemented.sessionId, resumedFrom: implemented.resumedFrom, mode: implemented.mode, account: implemented.account } : null,
    active: activeIn(run, scope),
    completed,
    implementUsd: implemented ? (implemented.usage?.usd ?? implemented.usd) : null,
    l0: l0 ?? null,
    micro: micro ? { predictedDirectionMet: micro.predicted_direction_met, ...micro } : null,
    evals: evalsIn(steps, scope),
    outcome: stop ? settle(stop) : null,
  };
}

const QueueRecordSchema = z.object({ queue: z.array(IdeaSchema), rejected: z.array(z.looseObject({ code: z.string() })) });
const SelectionSchema = z.object({ picks: z.array(IdeaSchema), draws: z.array(z.object({ id: z.string(), draw: z.number() })), plannerTopK: z.array(z.string()) });
const PlanStepSchema = PlannerSchema.partial().extend({ ops: QueueOpsSchema });

/** The planner answer the round used: the retry when there was one. */
function planOf(steps: Steps, round: number) {
  const stepId = `${arStepId("plan")}:${round}`;
  const retried = steps.has(`${stepId}.retry`);
  const { ops, ...planner } = dispatched(steps, retried ? `${stepId}.retry` : stepId, PlanStepSchema) ?? { ops: QueueOpsSchema.parse({}) };
  return { ops, retried, planner: planner.agent === undefined ? undefined : PlannerSchema.parse(planner) };
}

/** What one recorded round holds; `summary` is absent until its ratchet step has settled it. */
interface Replayed {
  round: number;
  queue: z.infer<typeof QueueRecordSchema>;
  selection: z.infer<typeof SelectionSchema>;
  plan: ReturnType<typeof planOf>;
  summary?: RoundSummary;
  /** The round's settled outcomes in pick order, empty until the summary exists. */
  outcomes: Outcome[];
}

function replayRound(steps: Steps, round: number): Replayed | undefined {
  const selection = seeded(steps, `${arStepId("select")}:${round}`, SelectionSchema);
  const queue = seeded(steps, `${arStepId("queue")}:${round}`, QueueRecordSchema);
  if (!selection || !queue) return undefined;
  const summary = summaryOf(steps, round);
  const stops = selection.picks.flatMap((idea) => seeded(steps, `${arStepId("stop")}:${round}/${idea.id}`, OutcomeSchema) ?? []);
  const outcomes = summary ? finalOutcomes(stops, { sigma: summary.against.sigma, superseded: summary.superseded, reevals: summary.reevals }) : [];
  return { round, queue, selection, plan: planOf(steps, round), summary, outcomes };
}

function replayRounds(steps: Steps): Replayed[] {
  const rounds: Replayed[] = [];
  for (let replayed = replayRound(steps, 1); replayed; replayed = replayRound(steps, replayed.round + 1)) rounds.push(replayed);
  return rounds;
}

/** The registries the recipe built, replayed over each settled round's analysis lines and final outcomes. */
function registriesOf(rounds: readonly Replayed[]): Registries {
  return rounds.reduce((registries, { round, plan, selection, outcomes, summary }) => {
    if (!summary) return registries;
    const ideas = new Map(selection.picks.map((idea) => [idea.id, idea]));
    return outcomes.reduce((acc, outcome) => recordOutcome(acc, ideas.get(outcome.ideaId)!, outcome, round), recordAnalysis(registries, plan.ops.analysis, round));
  }, EMPTY_REGISTRIES);
}

/** How many parents an idea has within the run: 0 for a root, and a parent outside the run ends the chain. */
function lineageDepths(rounds: readonly Replayed[]): (idea: Idea) => ArIdeaView {
  const parentOf = new Map(rounds.flatMap(({ queue, selection }) => [...queue.queue, ...selection.picks]).map((idea) => [idea.id, idea.parent]));
  const depth = (id: string, seen: Set<string>): number => {
    const parent = parentOf.get(id);
    return parent === undefined || !parentOf.has(parent) || seen.has(parent) ? 0 : 1 + depth(parent, seen.add(parent));
  };
  return (idea) => ({ ...idea, lineageDepth: depth(idea.id, new Set([idea.id])) });
}

function roundView(steps: Steps, run: WorkflowRun, replayed: Replayed, withDepth: (idea: Idea) => ArIdeaView): ArRoundView {
  const { round, queue, selection, plan, summary, outcomes } = replayed;
  const settled = new Map(outcomes.map((outcome) => [outcome.ideaId, outcome]));
  const settle = (stop: Outcome) => settled.get(stop.ideaId) ?? stop;
  return {
    round,
    queue: queue.queue.map(withDepth),
    rejected: queue.rejected,
    plannerRetried: summary?.plannerRetried ?? plan.retried,
    ...(plan.planner ? { planner: plan.planner } : {}),
    exempt: plan.ops.exempt,
    analysis: plan.ops.analysis,
    selection: { picks: selection.picks.map((idea) => idea.id), draws: selection.draws, plannerTopK: selection.plannerTopK },
    ladders: selection.picks.map((idea) => ladderOf(steps, run, `${round}/${idea.id}`, withDepth(idea), settle)),
    ratchet: summary?.ratchet ?? null,
    moves: summary?.moves ?? [],
    reevals: reevalsOf(steps, round),
  };
}

function aggregatesOf(look: WorkflowRun) {
  const steps = indexSteps(look);
  const stepIds = [...steps.keys()].filter((stepId) => stepId.startsWith(`${arStepId("validate")}:`));
  return stepIds.map((stepId) => dispatched(steps, stepId, LookAggregateSchema)!);
}

/** Each look's aggregate, from its own validate run; the run's other sections never read them. */
function validatorOf(pinned: Pinned, looks: readonly WorkflowRun[]): Pick<ArRunView, "validator"> {
  const recorded = looks.flatMap(aggregatesOf);
  return recorded.length === 0 ? {} : { validator: { maxLooks: pinned.target.validator.maxLooks, looks: recorded.sort((a, b) => a.look - b.look) } };
}

/** `ar-end` when the loop finished; a run that threw recorded none, so its error's `[code]` says why. */
function stopReasonOf(steps: Steps, run: WorkflowRun): { stopReason?: string } {
  const end = seeded(steps, arStepId("end"), z.object({ stopReason: StopReasonSchema }));
  const code = end?.stopReason ?? /\[([\w-]+)\]/.exec(run.error ?? "")?.[1];
  return code === undefined ? {} : { stopReason: code };
}

function targetView(run: WorkflowRun, pinned: Pinned, baseline: readonly ArResult[]): ArTargetView {
  const { pin, ratchetRef, target } = pinned;
  const where = { ...(target.repo ? { repo: target.repo } : {}), ratchetPrefix: target.ratchetPrefix };
  return { name: targetName(run, pinned), pin, ratchetRef, metric: projectMetric(target.metric, baseline), phases: target.phases.map((phase) => phase.id), ...where };
}

/**
 * Where an idea's latest ladder forked and what it built, for its diff: the outcome's `against.head`, else the best the
 * round started from. Undefined when the run never picked the idea or its implementer has not answered.
 */
export function ideaRefs(run: WorkflowRun, ideaId: string): { base: string; head: string } | undefined {
  const steps = indexSteps(run);
  const pinned = pinnedOf(steps);
  if (!pinned) return undefined;
  let start = pinned.ratchetHead;
  let refs: { base: string; head: string } | undefined;
  for (const { round, selection, summary } of replayRounds(steps)) {
    const scope = `${round}/${ideaId}`;
    const stop = selection.picks.some((idea) => idea.id === ideaId) ? seeded(steps, `${arStepId("stop")}:${scope}`, OutcomeSchema) : undefined;
    const head = stop?.head ?? dispatched(steps, `${arStepId("implement")}:${scope}`, ImplementedSchema)?.head;
    if (head) refs = { base: stop?.against?.head ?? start, head };
    if (summary) start = summary.best.head;
  }
  return refs;
}

/** The run page's model; null until the pin step has recorded the target. `looks` are the run's validate runs. */
export function arRunView(run: WorkflowRun, looks: readonly WorkflowRun[] = []): ArRunView | null {
  const steps = indexSteps(run);
  const pinned = pinnedOf(steps);
  if (!pinned) return null;
  const baseline = baselineRuns(steps);
  const { b0, best } = bestOf(steps, pinned, baseline);
  const rounds = replayRounds(steps);
  const withDepth = lineageDepths(rounds);
  const evidence: EvidenceRow[] = rounds.flatMap(({ round, outcomes }) => outcomes.map((outcome) => evidenceRow(round, outcome)));
  const { lanes, rounds: roundLimit, minPool } = settingsOf(run);
  const { id: runId, status, startedAt, completedAt, error } = run;
  return {
    runId, status, startedAt, completedAt, error,
    ...stopReasonOf(steps, run),
    target: targetView(run, pinned, baseline),
    settings: { lanes, rounds: roundLimit, minPool },
    baseline: { runs: baseline.map(projectRun), b0 },
    best,
    rounds: rounds.map((replayed) => roundView(steps, run, replayed, withDepth)),
    registries: registriesOf(rounds),
    cells: cellTable(evidence),
    ...validatorOf(pinned, looks),
    ...snapshotsOf(steps),
  };
}
