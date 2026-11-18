import type { GateRecord } from "@titan-design/hitl";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches } from "../definition.js";
import { reviewWait } from "./review-wait.js";
import { spawnQueuePosition } from "./review-queue.js";
import type { Registration } from "./store.js";
import type { TrainHolder } from "./train.js";
import type { Phase } from "./step-phase.js";

/** sh-cleanup can wait an hour per part on agents to exit, long after main CI was read, so it must not read as a main CI wait. */
const cleanupWait = (run: WorkflowRun, phase: Phase): string | undefined =>
  phase === "post-merge" && run.currentStep !== null && stepIdMatches("sh-cleanup", run.currentStep) ? "cleaning up after the merge: head branch, task and agents" : undefined;

const BaseCheckData = z.object({ result: z.object({ allowed: z.literal(false), reason: z.string() }) });

/** While a head waits for its PR to be retargeted, the refused base is the next action. */
function baseWait(run: WorkflowRun, steps: readonly StepResult[]): string | undefined {
  if (run.currentStep === null || !stepIdMatches("base-wait", run.currentStep)) return undefined;
  const check = BaseCheckData.safeParse(steps.filter((result) => stepIdMatches("base-check", result.stepId)).at(-1)?.data);
  return check.success ? check.data.result.reason : undefined;
}

const FreezeHoldData = z.object({ result: z.object({ hold: z.literal(true), reason: z.string() }) });

function lastIndexWhere<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (match(items[index]!)) return index;
  return -1;
}

const HeldWakeData = z.object({ result: z.object({ kind: z.literal("unhandled"), reason: z.string(), held: z.unknown() }) });
const SentNoticeData = z.object({ result: z.object({ sent: z.literal(true) }) });

/**
 * While a held send-back waits for a new head, the refusal that held it is the next action, not an implementer's push.
 * The seat counts as told only by a sent notice recorded after that wake: a NO_REPRO, or a failed notice, reached the
 * wait through the owner's sent-back gate instead.
 */
function heldWakeWait(run: WorkflowRun, steps: readonly StepResult[]): string | undefined {
  if (run.status === "failed" || run.status === "cancelled" || run.currentStep === null || !stepIdMatches("await-new-head", run.currentStep)) return undefined;
  const at = lastIndexWhere(steps, (result) => stepIdMatches("sh-wake-implementer", result.stepId));
  const wake = HeldWakeData.safeParse(steps[at]?.data);
  if (!wake.success || wake.data.result.held === undefined) return undefined;
  const told = steps.slice(at + 1).some((result) => stepIdMatches("sh-exit-notice", result.stepId) && SentNoticeData.safeParse(result.data).success);
  return `no fixer could start (${wake.data.result.reason})${told ? "; the seat was told" : ""}, waiting for a new head`;
}

/**
 * After a no-verdict diagnosis the new-head wait is on the planner's findings, not a fix. The phase stays `fixing`
 * because agent-chat branches on it (seat-watch, park blocker, custody); only the next action says why (TP-3820).
 */
export function diagnosisWait(run: WorkflowRun, steps: readonly StepResult[], pending: { gate: GateRecord } | undefined): string | undefined {
  const current = run.currentStep;
  if (pending || run.status === "failed" || run.status === "cancelled" || current === null || !["await-new-head", "sh-await-new-head"].some((id) => stepIdMatches(id, current))) return undefined;
  const previous = steps.at(-1)?.stepId;
  return previous !== undefined && stepIdMatches("sh-no-verdict-diagnosis", previous) ? "waiting for the diagnosis planner's findings and a new head" : undefined;
}

/** While a red head waits out a frozen main or a red base, the hold's own reason is the next action. */
function freezeWait(run: WorkflowRun, steps: readonly StepResult[]): string | undefined {
  if (!["sh-freeze-wait", "sh-base-wait"].some((id) => run.currentStep !== null && stepIdMatches(id, run.currentStep))) return undefined;
  const hold = FreezeHoldData.safeParse(steps.filter((result) => stepIdMatches("sh-freeze-hold", result.stepId)).at(-1)?.data);
  return hold.success ? hold.data.result.reason : undefined;
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

export function nextAction(phase: Phase, headSha: string | null, gate: GateRecord | undefined, gateStep: string | undefined, registration: Registration, behind: TrainHolder | undefined): string {
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

export interface WaitContext {
  run: WorkflowRun;
  steps: readonly StepResult[];
  phase: Phase;
  headSha: string | null;
  pending?: { gate: GateRecord };
}

export const ciWaitRunning = (run: WorkflowRun): boolean => run.status === "running" && run.currentStep !== null && stepIdMatches("ci-wait", run.currentStep);

const CI_HEAD_UNREAD = "waiting for CI (head not yet read)";

const ciHeadUnread = ({ run, headSha, pending }: WaitContext): string | undefined => (headSha === null && ciWaitRunning(run) && !pending ? CI_HEAD_UNREAD : undefined);

/** The waits that outrank the phase's own next action, in the order they win. */
const LEADING_WAITS: readonly ((context: WaitContext) => string | undefined)[] = [
  ({ run, steps }) => freezeWait(run, steps),
  ({ run, steps }) => baseWait(run, steps),
  ({ run, steps }) => heldWakeWait(run, steps),
  ({ run, phase }) => cleanupWait(run, phase),
  ciHeadUnread,
];

export function leadingWait(context: WaitContext): string | undefined {
  for (const wait of LEADING_WAITS) {
    const reason = wait(context);
    if (reason !== undefined) return reason;
  }
  return undefined;
}
