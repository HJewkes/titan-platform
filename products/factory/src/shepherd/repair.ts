import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { step } from "../workflows/land.js";
import type { LandOutcome } from "../workflows/land.js";
import { afterFixerExit, afterHeldWake } from "./flake-check.js";
import { awaitNewHead, sentBackGate, tookWake, type GateRun, type PrTarget, type WakeRun } from "./gates.js";
import { noticeGate, seatOrGate } from "./gate-route.js";
import type { WakeOutcome, WakeRequest } from "./phases.js";
import { MAX_REPAIRS, escalationReason } from "./route-table.js";
import { REPAIR_STEP } from "./wake-brief.js";
import { isHeld } from "./held-wake.js";

const RepairRecord = z.looseObject({ repair: z.number().int().positive() });
const CiRedPayload = z.object({ failing: z.array(z.object({ name: z.string() })) });

/**
 * One repair budget per run, spent by every wake kind and counted across heads. Each spend is a step record, so a
 * replay and a new head keep the count; false means the budget is gone and nothing was recorded.
 */
export async function spendRepair(ctx: WorkflowContext, target: PrTarget, kind: WakeRequest["kind"], headSha: string): Promise<boolean> {
  const spent = ctx.iteration(REPAIR_STEP);
  if (spent >= MAX_REPAIRS) return false;
  await step(ctx, REPAIR_STEP, { ...target, kind, headSha, repair: spent + 1 }, RepairRecord);
  return true;
}

function repairDetail(kind: WakeRequest["kind"], headSha: string, payload: unknown): string {
  const failing = kind === "ci-red" ? CiRedPayload.safeParse(payload) : undefined;
  const checks = failing?.success && failing.data.failing.length > 0 ? `; failing checks: ${failing.data.failing.map((check) => check.name).join(", ")}` : "";
  return `the next ${kind} wake at ${headSha} would be past the budget${checks}`;
}

/**
 * A spent budget wakes no more agents: the seat is told, naming the wake kind that hit it and, for ci-red, the failing
 * checks, and the run waits for a head it pushes. The sent-back gate opens only when no seat was told.
 */
export function repairGate(run: GateRun, kind: WakeRequest["kind"], headSha: string, payload: unknown): Promise<LandOutcome | undefined> {
  const reason = escalationReason("repair-budget", repairDetail(kind, headSha, payload));
  return seatOrGate(
    () => noticeGate(run, "sh-sent-back", headSha, `the PR has used its repair budget: ${reason}`),
    () => awaitNewHead(run, headSha),
    (unsent) => {
      const prompt = `PR #${run.target.pr} in ${run.target.repo} at head ${headSha} has used its repair budget: ${reason}${unsent}. Await a new head or abandon?`;
      return sentBackGate(run, headSha, prompt, `a human abandoned the PR after the repair budget ran out at a ${kind} wake`);
    },
  );
}

/**
 * Whether an agent took the wake; a fixer that exited with no push is rerun, routed to its seat or sent back by
 * `afterFixerExit` instead, and a held send-back, which no agent took, goes to its seat or back by `afterHeldWake`.
 */
export async function afterWake(run: WakeRun & { state: { round: number; reruns: number } }, kind: WakeRequest["kind"], headSha: string, payload: unknown, outcome: WakeOutcome, leave: (outcome?: LandOutcome) => Error): Promise<boolean> {
  if (outcome.kind === "unhandled" && outcome.exited) return afterFixerExit(run, kind, headSha, payload, outcome, leave);
  if (isHeld(outcome)) return afterHeldWake(run, kind, headSha, outcome, leave);
  return tookWake(run, headSha, outcome);
}
