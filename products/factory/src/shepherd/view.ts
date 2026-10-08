import type { GateRecord } from "@titan-design/hitl";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches } from "../definition.js";
import { CiSnapshotResult } from "../workflows/land-steps.js";
import { reviewWait } from "./review-wait.js";
import { PhaseSchema, stepPhase, type Phase } from "./step-phase.js";
import { spawnQueuePosition } from "./spawn-gate.js";
import type { Registration } from "./store.js";
import type { TrainHolder } from "./train.js";
import type { WakeInput, WakeStepResult } from "./wake.js";

const KINDS = ["ci-red", "review", "conflict", "fix-proof"] as const;
const MODES = ["resume", "successor", "live"] as const;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Resolves to the list only when it names exactly the members of wake.ts's union, so a kind or mode added there fails the build here. */
type Tied<List extends readonly string[], Union extends string> = [Same<List[number], Union>] extends [true] ? List : never;
const WAKE_KINDS: Tied<typeof KINDS, WakeInput["kind"]> = KINDS;
const WAKE_MODES: Tied<typeof MODES, Extract<WakeStepResult, { kind: "woken" }>["mode"]> = MODES;

export { PHASES, PhaseSchema, stepPhase, type Phase } from "./step-phase.js";

/** The read model `shepherd.list` and `shepherd.timeline` return; TP-466 section 2 pins these shapes for the UI. */
export const WatchRowSchema = z.object({
  repo: z.string(),
  pr: z.number().int().nullable(),
  branch: z.string(),
  runId: z.string(),
  task: z.string(),
  phase: PhaseSchema,
  headSha: z.string().nullable(),
  phaseSince: z.string(),
  nextAction: z.string(),
  pendingGate: z.object({ gateId: z.string(), stepId: z.string(), since: z.string() }).nullable(),
  held: z.object({ reason: z.string(), satisfiedAt: z.string().optional(), satisfiedBy: z.string().optional() }).nullable(),
  stalled: z.object({ reason: z.string() }).nullable(),
  /** How the run ended: `merged`, or `stopped` with the land reason; null while it runs and for runs older than the record. */
  outcome: z.object({ kind: z.enum(["merged", "stopped"]), reason: z.string().nullable() }).nullable(),
});
export type WatchRow = z.infer<typeof WatchRowSchema>;

export const TimelineEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("step"),
    stepId: z.string(),
    iteration: z.number().int(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    signal: z.string().nullable(),
    status: z.enum(["running", "done", "failed"]),
  }),
  z.object({ kind: z.literal("ci"), stepId: z.string(), headSha: z.string(), conclusion: z.string(), runUrl: z.string().nullable() }),
  z.object({
    kind: z.literal("wake"),
    stepId: z.string(),
    /** Null where the step's record does not say: an implementer wake records its outcome, not its request. */
    request: z.enum(WAKE_KINDS).nullable(),
    /** Null for the FIX_FIRST counter, which is recorded before the wake it counts. */
    outcome: z.enum(["woken", "unhandled"]).nullable(),
    agent: z.string().nullable(),
    mode: z.enum(WAKE_MODES).nullable(),
    sessionId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("verdict"),
    stepId: z.string(),
    verdict: z.enum(["MERGE", "FIX_FIRST", "none"]),
    headSha: z.string().nullable(),
    locator: z.object({ path: z.string(), start: z.number(), end: z.number() }).nullable(),
    reviewer: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("gate"),
    stepId: z.string(),
    gateId: z.string(),
    status: z.string(),
    createdAt: z.string(),
    resolvedAt: z.string().nullable(),
    resolvedBy: z.string().nullable(),
  }),
]);
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const PrTimelineSchema = z.object({ row: WatchRowSchema, entries: z.array(TimelineEntrySchema) });
export type PrTimeline = z.infer<typeof PrTimelineSchema>;

const TERMINAL_PHASE: Partial<Record<WorkflowRun["status"], Phase>> = { completed: "done", failed: "failed", cancelled: "cancelled" };

/** Completed step results, oldest first. */
function completedSteps(run: WorkflowRun): StepResult[] {
  return Object.values(run.stepResults).sort((a, b) => a.completedAt.localeCompare(b.completedAt));
}

function runPhase(run: WorkflowRun, steps: readonly StepResult[]): Phase {
  const terminal = TERMINAL_PHASE[run.status];
  if (terminal) return terminal;
  const current = run.currentStep ?? steps.at(-1)?.stepId;
  return current === undefined ? (run.params.pr === undefined ? "awaiting-pr" : "ci") : stepPhase(current);
}

function headOf(result: StepResult): string | undefined {
  const data = result.data as { headSha?: unknown; result?: { headSha?: unknown } } | undefined;
  const head = data?.headSha ?? data?.result?.headSha;
  return typeof head === "string" ? head : undefined;
}

function phaseSince(run: WorkflowRun, steps: readonly StepResult[], phase: Phase): string {
  if (TERMINAL_PHASE[run.status]) return run.completedAt ?? run.startedAt;
  const previous = steps.filter((result) => stepPhase(result.stepId) !== phase).at(-1);
  return previous?.completedAt ?? run.startedAt;
}

const WAITING: Readonly<Record<Phase, string>> = {
  "awaiting-pr": "waiting for a PR on the registered branch",
  ci: "waiting for CI",
  fixing: "waiting for the implementer's new head",
  review: "waiting for the review",
  "awaiting-approval": "waiting on the merge decision",
  merging: "merging",
  "post-merge": "watching main CI after the merge",
  done: "none",
  failed: "none",
  cancelled: "none",
};

function nextAction(phase: Phase, headSha: string | null, gate: GateRecord | undefined, gateStep: string | undefined, registration: Registration, behind: TrainHolder | undefined): string {
  if (gate) return `owner: resolve ${gateStep}`;
  if (phase === "merging" && behind) return `waiting for the merge train behind run ${behind.runId} (#${behind.pr})`;
  if (phase === "ci" && headSha) return `waiting for CI on ${headSha.slice(0, 7)}`;
  return (phase === "review" && admissionWait(registration)) || WAITING[phase];
}

/** A review the spawn gate keeps waiting also says where it stands in the gate's queue. */
function admissionWait({ repo, pr }: Registration): string | undefined {
  const wait = reviewWait(repo, pr);
  const position = spawnQueuePosition(repo, pr);
  return wait && position ? `${wait}; waiting for a spawn slot, ${position}` : wait;
}

/**
 * A held run's merge step polls the hold rather than merging, so its next action names the hold and the merging limit
 * does not apply. The phase stays `merging` until CC-791: agent-chat's burndown rejects a status array with any phase
 * it does not know. Only a hold satisfied at the run's own head lets the merge through.
 */
function waitsOnHold(run: WorkflowRun, held: WatchRow["held"], headSha: string | null): boolean {
  const merging = run.currentStep !== null && stepIdMatches("merge", run.currentStep);
  return merging && held !== null && (headSha === null || held.satisfiedAt !== headSha);
}

function holdWait({ holdReason, holdReviewer }: Registration, headSha: string | null): string {
  const verdict = holdReviewer ? `, or for a MERGE from ${holdReviewer}${headSha ? ` at ${headSha.slice(0, 7)}` : ""}` : "";
  return `waiting for the hold to be released (${holdReason ?? "held"})${verdict}`;
}

const FreezeHoldData = z.object({ result: z.object({ hold: z.literal(true), reason: z.string() }) });

/** While a red head waits out a frozen main, the hold's own reason is the next action. */
function freezeWait(run: WorkflowRun, steps: readonly StepResult[]): string | undefined {
  if (run.currentStep === null || !stepIdMatches("sh-freeze-wait", run.currentStep)) return undefined;
  const hold = FreezeHoldData.safeParse(steps.filter((result) => stepIdMatches("sh-freeze-hold", result.stepId)).at(-1)?.data);
  return hold.success ? hold.data.result.reason : undefined;
}

export interface RowInput {
  registration: Registration;
  run: WorkflowRun;
  /** The gate the run waits on now, with the step it belongs to. */
  pending?: { gate: GateRecord; stepId: string };
  /** The run holding the repo's merge train, if any. */
  train?: TrainHolder;
  /** The clock the stall limits read; defaults to the wall clock. */
  now?: Date;
}

const StoppedData = z.object({ result: z.object({ reason: z.string() }) });

/** How a finished run ended, from its sh-landed or sh-stopped step; null while neither is recorded. */
export function runOutcome(steps: readonly StepResult[]): WatchRow["outcome"] {
  if (steps.some((result) => result.stepId.startsWith("sh-landed"))) return { kind: "merged", reason: null };
  const stopped = steps.find((result) => result.stepId.startsWith("sh-stopped"));
  const parsed = stopped && StoppedData.safeParse(stopped.data);
  return parsed ? { kind: "stopped", reason: parsed.success ? parsed.data.result.reason : null } : null;
}

/** Three, as in MAX_FAILED_ROUNDS: a broker still refusing after three retries, each with its busy wait, needs a human's look. */
export const MAX_NOT_STARTED_REVIEWS = 3;

/** Review dispatches since the last one that started a reviewer; the run never counts these, so only the view does. */
function notStartedStreak(steps: readonly StepResult[]): number {
  const reviews = steps.filter((result) => result.stepId.split(":")[0] === "sh-review");
  return reviews.reduce((streak, result) => (result.data?.notStarted === true ? streak + 1 : 0), 0);
}

const MINUTE = 60_000;

/** Longest a run may sit in a phase before it reads as stalled; phases that wait on a person or an agent by design have no limit. */
export const PHASE_STALL_LIMIT_MS: Readonly<Partial<Record<Phase, number>>> = {
  ci: 60 * MINUTE,
  fixing: 240 * MINUTE,
  review: 120 * MINUTE,
  merging: 15 * MINUTE,
};

function overstayReason(phase: Phase, since: string, now: Date): string | undefined {
  const limit = PHASE_STALL_LIMIT_MS[phase];
  const elapsed = now.getTime() - Date.parse(since);
  return limit !== undefined && elapsed > limit ? `${Math.floor(elapsed / MINUTE)} min in ${phase}, over the ${limit / MINUTE} min limit` : undefined;
}

/** A merge waiting on a hold waits on a person by design, so only the phase limit is skipped for it. */
function stallReason(run: WorkflowRun, steps: readonly StepResult[], phase: Phase, since: string, now: Date, holding: boolean): string | undefined {
  if (run.status === "failed" || run.status === "recovery_required") return run.error ?? run.status;
  const streak = notStartedStreak(steps);
  if (streak >= MAX_NOT_STARTED_REVIEWS) return `${streak} review dispatches in a row started no reviewer`;
  return holding ? undefined : overstayReason(phase, since, now);
}

/** A satisfied hold names the head its reviewer sent MERGE at, and the session that wrote it. */
function heldView({ held, holdReason, holdSatisfied }: Registration): WatchRow["held"] {
  if (!held) return null;
  if (holdSatisfied === null) return { reason: holdReason ?? "held" };
  const { reviewer, agentId, sessionId } = holdSatisfied.by;
  return { reason: holdReason ?? "held", satisfiedAt: holdSatisfied.head, satisfiedBy: `${reviewer} (${agentId}/${sessionId})` };
}

/** One watch-list row; a failed run, a review the broker keeps refusing, or a phase past its limit reads as stalled. */
export function watchRow({ registration, run, pending, train, now = new Date() }: RowInput): WatchRow {
  const steps = completedSteps(run);
  const headSha = steps.map(headOf).filter((head) => head !== undefined).at(-1) ?? null;
  const phase = runPhase(run, steps);
  const held = heldView(registration);
  const holding = phase === "merging" && waitsOnHold(run, held, headSha);
  const since = phaseSince(run, steps, phase);
  const stalled = stallReason(run, steps, phase, since, now, holding);
  return {
    repo: registration.repo,
    pr: registration.pr,
    branch: registration.branch ?? run.params.branch ?? "",
    runId: run.id,
    task: registration.task,
    phase,
    headSha,
    phaseSince: since,
    nextAction: freezeWait(run, steps) ?? (holding ? holdWait(registration, headSha) : nextAction(phase, headSha, pending?.gate, pending?.stepId, registration, train?.runId === run.id ? undefined : train)),
    pendingGate: pending ? { gateId: pending.gate.id, stepId: pending.stepId, since: pending.gate.createdAt } : null,
    held,
    stalled: stalled === undefined ? null : { reason: stalled },
    outcome: runOutcome(steps),
  };
}

/** Step entries in completion order, a running step last, and every gate the run opened at its creation time. */
export function timelineEntries(run: WorkflowRun, gates: readonly GateRecord[]): TimelineEntry[] {
  const done = completedSteps(run).map((result) => ({ at: result.completedAt, entry: stepEntry(result) }));
  const running = Object.values(run.activeSteps).map((active) => ({
    at: active.startedAt,
    entry: { kind: "step", stepId: active.stepId, iteration: 0, startedAt: active.startedAt, completedAt: null, signal: null, status: "running" } satisfies TimelineEntry,
  }));
  const opened = gates.map((gate) => ({ at: gate.createdAt, entry: gateEntry(gate) }));
  return [...done, ...running, ...opened].sort((a, b) => a.at.localeCompare(b.at)).map(({ entry }) => entry);
}

function stepEntry(result: StepResult): TimelineEntry {
  const payload = (result.data as { result?: unknown } | undefined)?.result;
  const ci = stepPhase(result.stepId) === "ci" ? CiSnapshotResult.safeParse(payload) : undefined;
  if (ci?.success) return { kind: "ci", stepId: result.stepId, headSha: ci.data.headSha, conclusion: ci.data.verdict, runUrl: null };
  const recorded = recordedEntry(result.stepId, payload);
  if (recorded !== undefined) return recorded;
  return { kind: "step", stepId: result.stepId, iteration: result.iteration, startedAt: null, completedAt: result.completedAt, signal: result.signal, status: "done" };
}

const LocatorRecord = z.looseObject({
  source: z.looseObject({ path: z.string() }),
  evidence: z.looseObject({ line: z.looseObject({ byteOffset: z.number(), byteLength: z.number() }) }),
});
const VerdictRecord = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("verdict"), verdict: z.enum(["MERGE", "FIX_FIRST"]), head: z.string(), locator: z.unknown(), reviewer: z.looseObject({ agentId: z.string() }) }),
  z.looseObject({ kind: z.literal("none") }),
]);
const WakeRecord = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("woken"), agent: z.string(), mode: z.enum(WAKE_MODES).optional(), sessionId: z.string().optional() }),
  z.looseObject({ kind: z.literal("unhandled") }),
]);
const FixFirstRecord = z.looseObject({ fixFirst: z.number().int().positive() });

/** A verdict or wake step whose record parses gets its own entry; anything else stays a plain step. */
function recordedEntry(stepId: string, payload: unknown): TimelineEntry | undefined {
  if (stepIdMatches("sh-await-verdict", stepId)) return verdictEntry(stepId, payload);
  if (stepIdMatches("sh-wake-implementer", stepId)) return wakeEntry(stepId, payload);
  if (stepIdMatches("sh-wake-fix-first", stepId) && FixFirstRecord.safeParse(payload).success) {
    return { kind: "wake", stepId, request: "review", outcome: null, agent: null, mode: null, sessionId: null };
  }
  return undefined;
}

function verdictEntry(stepId: string, payload: unknown): TimelineEntry | undefined {
  const parsed = VerdictRecord.safeParse(payload);
  if (!parsed.success) return undefined;
  const none = { kind: "verdict", stepId, verdict: "none", headSha: null, locator: null, reviewer: null } as const;
  if (parsed.data.kind === "none") return none;
  const { verdict, head, reviewer } = parsed.data;
  return { ...none, verdict, headSha: head, locator: locatorView(parsed.data.locator), reviewer: reviewer.agentId };
}

/** The transcript path and the byte span of the verdict's line; an external review's locator has neither. */
function locatorView(raw: unknown): { path: string; start: number; end: number } | null {
  const parsed = LocatorRecord.safeParse(raw);
  if (!parsed.success) return null;
  const { byteOffset, byteLength } = parsed.data.evidence.line;
  return { path: parsed.data.source.path, start: byteOffset, end: byteOffset + byteLength };
}

function wakeEntry(stepId: string, payload: unknown): TimelineEntry | undefined {
  const parsed = WakeRecord.safeParse(payload);
  if (!parsed.success) return undefined;
  const unhandled = { kind: "wake", stepId, request: null, outcome: "unhandled", agent: null, mode: null, sessionId: null } as const;
  if (parsed.data.kind === "unhandled") return unhandled;
  return { ...unhandled, outcome: "woken", agent: parsed.data.agent, mode: parsed.data.mode ?? null, sessionId: parsed.data.sessionId ?? null };
}

function gateEntry(gate: GateRecord): TimelineEntry {
  const stepId = gate.id.slice(gate.id.indexOf("/") + 1);
  const resolvedBy = gate.resolvedBy === undefined ? null : `${gate.resolvedBy.class}:${gate.resolvedBy.id}`;
  return { kind: "gate", stepId, gateId: gate.id, status: gate.status, createdAt: gate.createdAt, resolvedAt: gate.resolvedAt ?? null, resolvedBy };
}
