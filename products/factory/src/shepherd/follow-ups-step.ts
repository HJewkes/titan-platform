import { FOLLOW_UPS_WARNINGS, FollowUpSchema, type FollowUp, type FollowUpsWarning, type ReviewTarget } from "@titan-design/review-panel";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { fileFollowUps, type FollowUpTasks } from "./follow-ups-file.js";
import type { Awaited } from "./review-schemas.js";

type AwaitedResult = z.infer<typeof Awaited>;

export const FOLLOW_UPS_STEP = "sh-follow-ups";
export const FOLLOW_UPS_STEPS: readonly StepDeclaration[] = [{ id: FOLLOW_UPS_STEP, kind: "dispatch" }];

/** Each active-work call gets this long; the loopback daemon answers in milliseconds, and `liveSource` itself has no timeout. */
export const FOLLOW_UPS_RPC_TIMEOUT_MS = 10_000;

const Warning = z.enum(FOLLOW_UPS_WARNINGS);
const FollowUpsInput = z.looseObject({ runId: z.string(), task: z.string().optional(), repo: z.string(), pr: z.number(), head: z.string(), reviewer: z.string(), followUps: z.array(FollowUpSchema).optional(), followUpsWarning: Warning.optional() });
type FollowUpsInput = z.infer<typeof FollowUpsInput>;
const FiledSchema = z.looseObject({ title: z.string(), id: z.string(), deduped: z.boolean() });
const FollowUpsResult = z.looseObject({ filed: z.array(FiledSchema), warning: z.string().optional(), skipped: z.string().optional(), error: z.string().optional() });
type FollowUpsResult = z.infer<typeof FollowUpsResult>;

function errorOf(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 200);
}

/** Rejects once the step is aborted or `ms` passes; the abandoned call is left to settle on its own, unread. */
function bounded<T>(work: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  const limit = AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(limit.reason instanceof Error ? limit.reason : new Error("follow-up filing aborted"));
    if (limit.aborted) return abort();
    limit.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => limit.removeEventListener("abort", abort));
  });
}

function boundedTasks(tasks: FollowUpTasks, signal: AbortSignal, ms: number): FollowUpTasks {
  return {
    openTasks: (initiative) => bounded(tasks.openTasks(initiative), signal, ms),
    add: (initiative, fields) => bounded(tasks.add(initiative, fields), signal, ms),
    appendNote: (initiative, id, line) => bounded(tasks.appendNote(initiative, id, line), signal, ms),
  };
}

function taskRef(task: string | undefined): { initiative: string; parent: string } | undefined {
  const slash = task?.indexOf("/") ?? -1;
  if (task === undefined || slash <= 0 || slash === task.length - 1) return undefined;
  return { initiative: task.slice(0, slash), parent: task.slice(slash + 1) };
}

/** Never throws: the step sits between a verdict and its next step, so a filing that fails is recorded and the verdict goes on. */
export async function followUpsBody(tasks: FollowUpTasks | undefined, input: FollowUpsInput, signal: AbortSignal, timeoutMs = FOLLOW_UPS_RPC_TIMEOUT_MS): Promise<FollowUpsResult> {
  const warning = input.followUpsWarning && { warning: input.followUpsWarning };
  const items = input.followUps ?? [];
  if (items.length === 0) return { filed: [], ...warning };
  if (!tasks) return { filed: [], ...warning, skipped: "unwired" };
  const ref = taskRef(input.task);
  if (!ref) return { filed: [], ...warning, skipped: "no-task" };
  try {
    const where = { ...ref, repo: input.repo, pr: input.pr, head: input.head, reviewer: input.reviewer };
    return { ...(await fileFollowUps(boundedTasks(tasks, signal, timeoutMs), where, items)), ...warning };
  } catch (error) {
    return { filed: [], ...warning, error: errorOf(error) };
  }
}

export function followUpsRoute(now: () => number, tasks: FollowUpTasks | undefined, timeoutMs?: number): StepRoute {
  return codeRoute(FOLLOW_UPS_STEP, now, async (raw: unknown, signal) => {
    const input = FollowUpsInput.safeParse(raw);
    return input.success ? followUpsBody(tasks, input.data, signal, timeoutMs) : { filed: [], error: "unreadable sh-follow-ups input" };
  });
}

function followUpsOf(awaited: AwaitedResult): { followUps?: FollowUp[]; followUpsWarning?: FollowUpsWarning } {
  const items = z.array(FollowUpSchema).safeParse(awaited.followUps);
  const warning = Warning.safeParse(awaited.followUpsWarning);
  return { ...(items.success && items.data.length > 0 && { followUps: items.data }), ...(warning.success && { followUpsWarning: warning.data }) };
}

/**
 * Files a verdict's follow-ups, MERGE or FIX_FIRST, before the verdict is acted on; a verdict with no Follow-ups block records
 * nothing. A run whose record continues past this point without the step took its verdict before the step existed, so its
 * replay skips it.
 */
export async function fileFollowUpsAt(ctx: WorkflowContext, target: ReviewTarget, awaited: AwaitedResult, suffix = ""): Promise<void> {
  if (awaited.kind !== "verdict") return;
  const found = followUpsOf(awaited);
  if (found.followUps === undefined && found.followUpsWarning === undefined) return;
  const next = ctx.historyNext();
  if (next !== undefined && !stepIdMatches(FOLLOW_UPS_STEP, next)) return;
  const reviewer = z.object({ agentId: z.string() }).safeParse(awaited.reviewer);
  const task = ctx.param("task");
  const input = { runId: ctx.runId, ...(task !== undefined && { task }), repo: target.repo, pr: target.pr, head: target.head, reviewer: reviewer.success ? reviewer.data.agentId : "unknown", ...found };
  await step(ctx, `${FOLLOW_UPS_STEP}:${target.head}${suffix}`, input, FollowUpsResult);
}
