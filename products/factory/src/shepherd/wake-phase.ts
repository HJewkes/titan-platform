import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { AwaitHeadResult } from "../workflows/await-head.js";
import { step } from "../workflows/land.js";
import { fixProofBounce } from "./fix-proof-cap.js";
import type { HeldWake } from "./held-wake.js";
import type { ShepherdPhases, WakeEvidence, WakeOutcome, WakeRequest } from "./phases.js";
import { fixFirstCount } from "./wake-brief.js";
import { AWAIT_NEW_HEAD_STEP, WAKE_STEP } from "./wake.js";

const Woke = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("woken"), agent: z.string(), sessionId: z.string().optional(), mode: z.enum(["resume", "successor", "live"]).optional(), askedAt: z.number().optional(), fallback: z.enum(["resume", "message"]).optional() }),
  z.looseObject({ kind: z.literal("unhandled"), reason: z.string(), held: z.looseObject({ agent: z.string() }).optional() }),
]);

/** A review wake names the FIX_FIRST its round recorded, so the second is known however many heads came between. */
function fixFirstOf(ctx: WorkflowContext, request: WakeRequest): number | undefined {
  if (request.kind !== "review") return undefined;
  const count = fixFirstCount(ctx);
  return count > 0 ? count : undefined;
}

/**
 * Wakes an agent, then waits for the head to move; `woken` means a new head exists, or, after a ci-red wake, that the
 * same head turned green on a rerun, so the next round's ci-wait collects its merge facts. A second wake in one round replays at the next index.
 */
export const wakePhase: ShepherdPhases["wake"] = async (ctx, request) => {
  const capped = await fixProofBounce(ctx, request);
  if (capped !== undefined) return capped;
  const fixFirst = fixFirstOf(ctx, request);
  const woke = await wakeStep(ctx, request, fixFirst);
  return woke.kind === "woken" ? redeliverAfterLiveExit(ctx, request, await awaitFixerHead(ctx, request, woke), woke, fixFirst) : notWoken(woke);
};

function notWoken(woke: Extract<z.infer<typeof Woke>, { kind: "unhandled" }>): WakeOutcome | HeldWake {
  return woke.held === undefined ? { kind: "unhandled", reason: woke.reason } : { kind: "unhandled", reason: woke.reason, held: woke.held };
}

const wakeStep = (ctx: WorkflowContext, request: WakeRequest, fixFirst: number | undefined) => step(ctx, `${WAKE_STEP}:${request.round}`, { ...request, runId: ctx.runId, ...(fixFirst !== undefined && { fixFirst }) }, Woke);

/**
 * A live agent can end its turn before it reads a chat-sent wake, so the wake is asked once more after its exit: the
 * agent is resumed, or a successor started, with the wake as its prompt. Resume and successor wakes, and a live wake
 * its resume fallback delivered, were the prompt already, and a second exit takes the exit route.
 */
async function redeliverAfterLiveExit(ctx: WorkflowContext, request: WakeRequest, outcome: WakeOutcome, woke: WakeEvidence, fixFirst: number | undefined): Promise<WakeOutcome> {
  if (outcome.kind !== "unhandled" || outcome.exited !== true || woke.mode !== "live" || woke.fallback === "resume") return outcome;
  const again = await wakeStep(ctx, request, fixFirst);
  return again.kind === "woken" ? awaitFixerHead(ctx, request, again) : notWoken(again);
}

/** The wait after a wake an agent took; only a ci-red wake can end on its own head turning green. */
export async function awaitFixerHead(ctx: WorkflowContext, request: WakeRequest, woke: WakeEvidence): Promise<WakeOutcome> {
  const target = { repo: request.repo, pr: request.pr, headSha: request.headSha, agent: woke.agent, ...(request.kind === "ci-red" && { untilGreen: true }) };
  const head = await step(ctx, `${AWAIT_NEW_HEAD_STEP}:${request.round}`, target, AwaitHeadResult);
  const woken = { kind: "woken" as const, agent: woke.agent, ...(woke.sessionId !== undefined && { sessionId: woke.sessionId }) };
  if (head.green) return { ...woken, sameHead: true };
  if (head.exited) return { kind: "unhandled", exited: true, reason: `${woke.agent} exited without pushing a new head past ${request.headSha}`, wake: woke };
  if (head.headSha === request.headSha) return { kind: "unhandled", reason: `${request.repo}#${request.pr} closed at head ${request.headSha} before a new head` };
  return woken;
}
