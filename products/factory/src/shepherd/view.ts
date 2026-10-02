import type { GateRecord } from "@titan-design/hitl";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { CiSnapshotResult } from "../workflows/land-steps.js";
import { reviewWait } from "./review-wait.js";
import type { Registration } from "./store.js";

/** The read model `shepherd.list` and `shepherd.timeline` return; TP-466 section 2 pins these shapes for the UI. */
export const PHASES = ["awaiting-pr", "ci", "fixing", "review", "awaiting-approval", "merging", "post-merge", "done", "failed", "cancelled"] as const;

export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

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
  held: z.object({ reason: z.string() }).nullable(),
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
    request: z.enum(["ci-red", "review", "conflict"]),
    outcome: z.enum(["woken", "unhandled"]),
    agent: z.string().nullable(),
    mode: z.enum(["resume", "successor"]).nullable(),
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
  z.object({ kind: z.literal("evidence"), stepId: z.string(), record: z.record(z.string(), z.unknown()) }),
]);
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const PrTimelineSchema = z.object({ row: WatchRowSchema, entries: z.array(TimelineEntrySchema) });
export type PrTimeline = z.infer<typeof PrTimelineSchema>;

/** A step id's prefix, before any `:n`, to its phase; an unknown prefix reads as `ci` so a new step never breaks a view. */
const STEP_PHASE: Readonly<Record<string, Phase>> = {
  "sh-await-pr": "awaiting-pr",
  "land-rules": "ci",
  "ci-wait": "ci",
  "update-branch": "ci",
  rerun: "ci",
  "sh-wake": "fixing",
  "await-new-head": "fixing",
  "sh-await-new-head": "fixing",
  "sh-park": "review",
  "sh-review-intent": "review",
  "sh-review": "review",
  "sh-merge-evidence": "review",
  "sh-await-verdict": "review",
  "sh-policy": "review",
  "merge-policy": "awaiting-approval",
  "approve-merge": "awaiting-approval",
  "ci-failed": "awaiting-approval",
  "sh-sent-back": "awaiting-approval",
  "stuck-behind": "awaiting-approval",
  merge: "merging",
  "sh-landed": "post-merge",
  "sh-main-ci": "post-merge",
  "main-red": "post-merge",
  "after-stages": "post-merge",
  "sh-freeze": "post-merge",
  "sh-file-fix-task": "post-merge",
  "sh-spawn-fixer": "post-merge",
  "sh-cleanup": "post-merge",
};

const TERMINAL_PHASE: Partial<Record<WorkflowRun["status"], Phase>> = { completed: "done", failed: "failed", cancelled: "cancelled" };

export function stepPhase(stepId: string): Phase {
  return STEP_PHASE[stepId.split(":")[0]!] ?? "ci";
}

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

function nextAction(phase: Phase, headSha: string | null, gate: GateRecord | undefined, gateStep: string | undefined, registration: Registration): string {
  if (gate) return `owner: resolve ${gateStep}`;
  if (phase === "ci" && headSha) return `waiting for CI on ${headSha.slice(0, 7)}`;
  return (phase === "review" && reviewWait(registration.repo, registration.pr)) || WAITING[phase];
}

export interface RowInput {
  registration: Registration;
  run: WorkflowRun;
  /** The gate the run waits on now, with the step it belongs to. */
  pending?: { gate: GateRecord; stepId: string };
}

const StoppedData = z.object({ result: z.object({ reason: z.string() }) });

function runOutcome(steps: readonly StepResult[]): WatchRow["outcome"] {
  if (steps.some((result) => result.stepId.startsWith("sh-landed"))) return { kind: "merged", reason: null };
  const stopped = steps.find((result) => result.stepId.startsWith("sh-stopped"));
  const parsed = stopped && StoppedData.safeParse(stopped.data);
  return parsed ? { kind: "stopped", reason: parsed.success ? parsed.data.result.reason : null } : null;
}

/** One watch-list row; stall limits per phase are left to TP-492, so only a failed or parked run reads as stalled. */
export function watchRow({ registration, run, pending }: RowInput): WatchRow {
  const steps = completedSteps(run);
  const phase = runPhase(run, steps);
  const headSha = steps.map(headOf).filter((head) => head !== undefined).at(-1) ?? null;
  const stuck = run.status === "failed" || run.status === "recovery_required";
  return {
    repo: registration.repo,
    pr: registration.pr,
    branch: registration.branch ?? run.params.branch ?? "",
    runId: run.id,
    task: registration.task,
    phase,
    headSha,
    phaseSince: phaseSince(run, steps, phase),
    nextAction: nextAction(phase, headSha, pending?.gate, pending?.stepId, registration),
    pendingGate: pending ? { gateId: pending.gate.id, stepId: pending.stepId, since: pending.gate.createdAt } : null,
    held: registration.held ? { reason: registration.holdReason ?? "held" } : null,
    stalled: stuck ? { reason: run.error ?? run.status } : null,
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
  const ci = stepPhase(result.stepId) === "ci" ? CiSnapshotResult.safeParse((result.data as { result?: unknown } | undefined)?.result) : undefined;
  if (ci?.success) return { kind: "ci", stepId: result.stepId, headSha: ci.data.headSha, conclusion: ci.data.verdict, runUrl: null };
  return { kind: "step", stepId: result.stepId, iteration: result.iteration, startedAt: null, completedAt: result.completedAt, signal: result.signal, status: "done" };
}

function gateEntry(gate: GateRecord): TimelineEntry {
  const stepId = gate.id.slice(gate.id.indexOf("/") + 1);
  const resolvedBy = gate.resolvedBy === undefined ? null : `${gate.resolvedBy.class}:${gate.resolvedBy.id}`;
  return { kind: "gate", stepId, gateId: gate.id, status: gate.status, createdAt: gate.createdAt, resolvedAt: gate.resolvedAt ?? null, resolvedBy };
}
