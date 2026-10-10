import type { RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { noticeHeldSeat } from "./gate-route.js";
import type { GateRun } from "./gates.js";
import type { ShepherdDeps, WakeRequest } from "./phases.js";
import type { Registration } from "./store.js";

const HELD_CHECK_STEP = "sh-held-check";
const HELD_WAIT_STEP = "sh-held-wait";
export const HELD_REPAIR_STEPS: readonly StepDeclaration[] = [
  { id: HELD_CHECK_STEP, kind: "dispatch" },
  { id: HELD_WAIT_STEP, kind: "dispatch" },
];
const DEFAULT_POLL_MS = 30_000;

const HeldCheckResult = z.looseObject({ held: z.boolean(), reason: z.string().optional(), seat: z.string().optional() });
const HeldWaitResult = z.looseObject({ moved: z.boolean() });
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

/** Polls until the hold is released or replaced, or the PR leaves the held head; a failed read is polled again. */
async function awaitRelease(deps: ShepherdDeps, input: HeldInput & { reason: string }, signal: AbortSignal): Promise<z.infer<typeof HeldWaitResult>> {
  for (;;) {
    signal.throwIfAborted();
    const pr = await deps.port.getPr(input.repo, input.pr).catch(() => undefined);
    if (pr && (pr.headSha !== input.headSha || pr.state !== "open")) return { moved: true };
    const now = heldCheck(deps.store.get().byRun(input.runId));
    if (!now.held || now.reason !== input.reason) return { moved: false };
    await deps.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
  }
}

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

/**
 * G10: a held run wakes no fixer and spends no repair, so nothing pushes while it is held. The seat is told once per
 * hold, head and cause, and the run waits. True means the head moved and the next round lands; false means the run is
 * not held, or its hold was released at this head, and the repair goes ahead as usual.
 */
export async function heldRepair(run: GateRun, kind: WakeRequest["kind"], headSha: string, payload: unknown): Promise<boolean> {
  const input: HeldInput = { runId: run.ctx.runId, ...run.target, headSha };
  for (;;) {
    const hold = await step(run.ctx, HELD_CHECK_STEP, input, HeldCheckResult);
    if (!hold.held) return false;
    const reason = hold.reason ?? "held";
    const why = `the run is held (${reason}), so Shepherd woke no fixer for the ${kind} wake: ${causeOf(kind, payload)}`;
    await noticeHeldSeat(run, JSON.stringify(["held", reason, headSha, kind]), { headSha, why, ...(hold.seat && { seat: hold.seat }) });
    if ((await step(run.ctx, HELD_WAIT_STEP, { ...input, reason }, HeldWaitResult)).moved) return true;
  }
}
