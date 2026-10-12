import type { PullRequest, RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import type { LandPrState } from "../workflows/land-pr.js";
import { rerunFlakyHead } from "./flake-check.js";
import { noticeHeldSeat } from "./gate-route.js";
import type { GateRun } from "./gates.js";
import type { ShepherdDeps, WakeRequest } from "./phases.js";
import { PUSH_WATCH_TICK_MS, headPoll, leftHead } from "./push-signal.js";
import type { Registration } from "./store.js";

const HELD_CHECK_STEP = "sh-held-check";
const HELD_WAIT_STEP = "sh-held-wait";
export const HELD_REPAIR_STEPS: readonly StepDeclaration[] = [
  { id: HELD_CHECK_STEP, kind: "dispatch" },
  { id: HELD_WAIT_STEP, kind: "dispatch" },
];
const HeldCheckResult = z.looseObject({ held: z.boolean(), reason: z.string().optional(), seat: z.string().optional() });
const HeldWaitResult = z.looseObject({ moved: z.boolean(), headSha: z.string().optional() });
const RedPayload = z.looseObject({ failing: z.array(z.looseObject({ name: z.string(), conclusion: z.string().nullish() })) });
const VerdictPayload = z.looseObject({ kind: z.string() });

interface HeldInput {
  runId: string;
  repo: RepoSlug;
  pr: number;
  headSha: string;
}

/** A joined seat or `none` names no one agent to message, so the hub seat stands in. */
export const singleSeat = (seat: string | undefined): string | undefined => (seat === undefined || seat === "none" || seat.includes("+") ? undefined : seat);

function heldCheck(registration: Registration | undefined): z.infer<typeof HeldCheckResult> {
  if (!registration?.held) return { held: false };
  const seat = singleSeat(registration.policy.seat);
  return { held: true, reason: registration.holdReason ?? "held", ...(seat && { seat }) };
}

/**
 * Waits until the hold is released or replaced, or the PR leaves the held head. The store is read every tick and the PR
 * only on a push to its branch or once per backstop; a failed read is read again.
 * A move records the open PR's new head, because shepherd status reads its head from completed results and the
 * next ci-wait has none while it runs.
 */
async function awaitRelease(deps: ShepherdDeps, input: HeldInput & { reason: string }, signal: AbortSignal): Promise<z.infer<typeof HeldWaitResult>> {
  const read = () => deps.port.getPr(input.repo, input.pr).catch(() => undefined);
  const poll = headPoll({ pushes: deps.pushes, repo: input.repo, headSha: input.headSha, tickMs: PUSH_WATCH_TICK_MS, read });
  for (;;) {
    signal.throwIfAborted();
    const polled = await poll.next();
    const pr = polled.read ? polled.pr : undefined;
    if (leftHead(pr, input.headSha)) return movedTo(pr);
    const now = heldCheck(deps.store.get().byRun(input.runId));
    if (!now.held || now.reason !== input.reason) {
      // A push from outside the clone while held is seen by no reflog, so the release reads the PR before a repair goes ahead.
      const last = polled.read ? undefined : await read();
      return leftHead(last, input.headSha) ? movedTo(last) : { moved: false };
    }
    await deps.sleep(poll.tickMs, signal);
  }
}

const movedTo = (pr: PullRequest): z.infer<typeof HeldWaitResult> => ({ moved: true, ...(pr.state === "open" && { headSha: pr.headSha }) });

/** The check reads the store at the moment of the wake; the wait only reads, so each repeats safely after a crash. */
export function heldRepairRoutes(deps: ShepherdDeps): StepRoute[] {
  return [
    codeRoute(HELD_CHECK_STEP, deps.now, async (input: HeldInput) => heldCheck(deps.store.get().byRun(input.runId))),
    codeRoute(HELD_WAIT_STEP, deps.now, async (input: HeldInput & { reason: string }, signal) => awaitRelease(deps, input, signal)),
  ];
}

/** What the fix round would have fixed: the failing checks, the verdict, or the conflict. */
function causeOf(kind: WakeRequest["kind"], payload: unknown): string {
  if (kind === "conflict") return "the PR conflicts with its base";
  if (kind === "ci-red") {
    const red = RedPayload.safeParse(payload);
    const checks = red.success ? red.data.failing.map((check) => `${check.name} (${check.conclusion ?? "no conclusion"})`).join(", ") : "";
    return `CI failed (${checks || "no failing check named"})`;
  }
  const verdict = VerdictPayload.safeParse(payload);
  return `the review said ${verdict.success ? verdict.data.kind : kind}`;
}

const isRerunStep = (stepId: string): boolean => /^rerun:\d+$/.test(stepId);

interface HeldStepIds {
  check: string;
  wait: string;
}

/**
 * A live check is keyed by round and head, so only this wake's own record can answer it: a run-wide counter let a
 * replay's back-filled `{held:false}` memo answer a later live wake on a held run (TP-2452). A replay whose record
 * goes on with the bare check keeps the bare ids, so a record from before the keying replays as it ran.
 */
function heldStepIds(run: GateRun & { state: LandPrState }, headSha: string): HeldStepIds {
  if (run.ctx.historyNext() === HELD_CHECK_STEP) return { check: HELD_CHECK_STEP, wait: HELD_WAIT_STEP };
  const key = `r${run.state.round}:${headSha}`;
  return { check: `${HELD_CHECK_STEP}:${key}`, wait: `${HELD_WAIT_STEP}:${key}` };
}

/** True while replaying, when the record's next step is not the one this wake would record: the record predates it. */
function recordedWithout(run: GateRun, records: (stepId: string) => boolean): boolean {
  const next = run.ctx.historyNext();
  return next !== undefined && !records(next);
}

/**
 * G10: a held run wakes no fixer and spends no repair, so nothing pushes while it is held. The seat is told once per
 * hold, head and cause, and the run waits. True means the head moved and the next round lands; false means the run is
 * not held, or its hold was released at this head, and the repair goes ahead as usual.
 * A run that is not held first reruns a red head's failed jobs once, so a flaky check never wakes the implementer.
 * The hold check and the rerun shipped in separate deploys, so a replay checks its record before each: a record that
 * went on without one took the path from before it, and a run that landed on that path must not touch CI again.
 */
export async function heldRepair(run: GateRun & { state: LandPrState }, kind: WakeRequest["kind"], headSha: string, payload: unknown): Promise<boolean> {
  if (recordedWithout(run, (stepId) => stepIdMatches(HELD_CHECK_STEP, stepId))) return false;
  const ids = heldStepIds(run, headSha);
  const input: HeldInput = { runId: run.ctx.runId, ...run.target, headSha };
  for (;;) {
    const hold = await step(run.ctx, ids.check, input, HeldCheckResult);
    if (!hold.held) return !recordedWithout(run, isRerunStep) && rerunFlakyHead(run, kind, headSha, payload);
    const reason = hold.reason ?? "held";
    const why = `the run is held (${reason}), so Shepherd woke no fixer for the ${kind} wake: ${causeOf(kind, payload)}`;
    await noticeHeldSeat(run, JSON.stringify(["held", reason, headSha, kind]), { headSha, why, ...(hold.seat && { seat: hold.seat }) });
    if ((await step(run.ctx, ids.wait, { ...input, reason }, HeldWaitResult)).moved) return true;
  }
}
