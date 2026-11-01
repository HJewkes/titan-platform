import type { ReviewTarget } from "@titan-design/review-panel";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import type { ReviewAccounts } from "./account-limit.js";
import { SHEPHERD_ACTOR } from "./events.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import type { ShepherdStore } from "./store.js";

export const NO_REVIEWER_HOLD_STEP = "sh-no-reviewer-hold";
const NO_REVIEWER_WAIT_STEP = "sh-no-reviewer-wait";
export const NO_REVIEWER_STEPS: readonly StepDeclaration[] = [
  { id: NO_REVIEWER_HOLD_STEP, kind: "dispatch" },
  { id: NO_REVIEWER_WAIT_STEP, kind: "dispatch" },
];
const DEFAULT_POLL_MS = 30_000;
/** How long one wait holds the run before it reviews again; a refusal that still stands finds its own hold and waits again, with no second alert. */
export const NO_REVIEWER_WAIT_LIMIT_MS = 60 * 60_000;

type Alert = ReviewAccounts["alert"];

interface HoldInput extends ReviewTarget {
  runId: string;
  /** Why the reviewer dispatch was refused, as the review step recorded it. */
  refusal: string;
  /** Set when preflight refused the head before any dispatch: the fixer fingerprint whose fix releases it (TP-3928). */
  fingerprint?: string;
}

/** `standing` is the gating hold the wait watches: this hold's reason, or another hold's that was already in place. */
const HoldResult = z.looseObject({ held: z.boolean(), placed: z.boolean(), alerted: z.boolean(), reason: z.string(), standing: z.string().optional() });
type Held = z.infer<typeof HoldResult>;

interface Placement {
  held: boolean;
  placed: boolean;
  reason: string;
  standing?: string;
}

const RESUMES = ["released", "head-moved", "closed", "expired"] as const;
const WaitResult = z.looseObject({ resumed: z.enum(RESUMES) });
type Waited = z.infer<typeof WaitResult>;

interface WaitInput extends HoldInput {
  reason: string;
  standing: string;
}

/** The head is in the reason, so a refusal at a new head is a new hold and tells the seat again. */
const noReviewerReason = (refusal: string, head: string): string => `no-reviewer: ${refusal} at ${head}; TP-2446`;

function remedyOf(input: HoldInput): string {
  if (input.fingerprint !== undefined) return `Fix the preflight error ${input.fingerprint} (review.workflow on:preflight; TP-3928)`;
  return `Bind a checkout of ${input.repo} (a seat's repos: line or shepherd.repos["${input.repo}"].path)`;
}

function noReviewerAlertText(input: HoldInput): string {
  return (
    `Shepherd: no reviewer could be started for ${input.repo}#${input.pr} at ${input.head}: ${input.refusal}. ` +
    `The run is held (no-reviewer; TP-2446) and opens no merge gate. ${remedyOf(input)}, ` +
    `then run \`titan-factory shepherd release ${input.repo}#${input.pr} --head ${input.head} --class no-reviewer\`.`
  );
}

/**
 * The reviewer dispatch was refused for a reason a retry cannot fix: hold the run as no-reviewer, tell the seat once, and wait
 * for a release or a head move. The review ends `not-started`, which reviews again without counting a failed round; a
 * preflight refusal names its fingerprint and ends `needs-fixer`, which does the same through `await-fixer`.
 */
export async function noReviewerHeld(ctx: WorkflowContext, target: ReviewTarget, refusal: string, fingerprint?: string): Promise<Verdict> {
  const input: HoldInput = { ...target, runId: ctx.runId, refusal, ...(fingerprint !== undefined && { fingerprint }) };
  const held = await step(ctx, `${NO_REVIEWER_HOLD_STEP}:${target.head}`, input, HoldResult);
  if (held.held && held.standing !== undefined) await step(ctx, `${NO_REVIEWER_WAIT_STEP}:${target.head}`, { ...input, reason: held.reason, standing: held.standing } satisfies WaitInput, WaitResult);
  return { kind: "none", cause: fingerprint === undefined ? "not-started" : "needs-fixer", reason: held.reason };
}

/** A failed alert never fails the hold: the run stays held and the step records that the seat was not told. */
async function alertSeat(alert: Alert, input: HoldInput): Promise<boolean> {
  if (!alert) return false;
  try {
    await alert(input.repo, noReviewerAlertText(input));
    return true;
  } catch (error) {
    console.warn(`shepherd: the no-reviewer alert for ${input.repo}#${input.pr} did not go out: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Places the hold only while no hold or release landed since the read, so a hold that raced in stands and is the one waited on. */
function placeHold(store: ShepherdStore, input: HoldInput, reason: string): Placement {
  const before = store.byRun(input.runId);
  if (before === undefined) return { held: false, placed: false, reason };
  if (before.held) return { held: true, placed: false, reason, standing: before.holdReason ?? reason };
  const placed = store.holdIfUnchanged(input.runId, store.changeMark(input.runId), reason, { actor: SHEPHERD_ACTOR, headSha: input.head });
  const after = store.byRun(input.runId)!;
  return after.held ? { held: true, placed, reason, standing: after.holdReason ?? reason } : { held: false, placed, reason };
}

async function holdRun(deps: ShepherdDeps, alert: Alert, input: HoldInput): Promise<Held> {
  const placement = placeHold(deps.store.get(), input, noReviewerReason(input.refusal, input.head));
  return { ...placement, alerted: placement.placed ? await alertSeat(alert, input) : false };
}

/**
 * The standing hold lifted or changed reads as a release; a PR that moved on reads as a head move. Only a read of state
 * "closed" drops this run's own hold, by its exact reason, so anyone else's hold stays.
 */
async function resumeReason(deps: ShepherdDeps, input: WaitInput): Promise<Waited["resumed"] | undefined> {
  const store = deps.store.get();
  const registration = store.byRun(input.runId);
  if (registration !== undefined && (!registration.held || registration.holdReason !== input.standing)) return "released";
  const pr = await deps.port.getPr(input.repo, input.pr);
  if (pr.state === "closed") {
    store.releaseIfHeld(input.runId, input.reason, { actor: SHEPHERD_ACTOR, headSha: input.head });
    return "closed";
  }
  return pr.headSha !== input.head ? "head-moved" : undefined;
}

/** Any read that fails keeps the hold and is polled again; expiry leaves the hold in place for the next review to find. */
async function awaitRelease(deps: ShepherdDeps, input: WaitInput, signal: AbortSignal): Promise<Waited> {
  const startedAt = deps.now();
  for (;;) {
    signal.throwIfAborted();
    const resumed = await resumeReason(deps, input).catch(() => undefined);
    if (resumed !== undefined) return { resumed };
    if (deps.now() - startedAt >= NO_REVIEWER_WAIT_LIMIT_MS) return { resumed: "expired" };
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
  }
}

export function noReviewerRoutes(deps: ShepherdDeps, alert?: Alert): StepRoute[] {
  return [
    codeRoute(NO_REVIEWER_HOLD_STEP, deps.now, async (input: HoldInput) => holdRun(deps, alert, input)),
    codeRoute(NO_REVIEWER_WAIT_STEP, deps.now, async (input: WaitInput, signal) => awaitRelease(deps, input, signal)),
  ];
}
