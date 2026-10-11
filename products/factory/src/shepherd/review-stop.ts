import { DEPTH_FLOOR_REASON } from "@titan-design/review-panel";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { awaitLift, type MachineStopWatch } from "./machine-stop.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { StopRead } from "./review-schemas.js";

const REVIEW_STOP_STEP = "sh-review-stop";
export const REVIEW_STOP_STEPS: readonly StepDeclaration[] = [{ id: REVIEW_STOP_STEP, kind: "dispatch" }];

/** `since` is epoch ms: when the reviewer started, or was dispatched when no start was read. */
const StopInputSchema = z.object({ head: z.string().min(1), since: z.number() });
type StopResult = z.infer<typeof StopRead>;

const DEFAULT_POLL_MS = 30_000;

/**
 * Whether the machine stop held at any point since `since`, or holds now, and if so waits for it to lift. The ledger lives in
 * memory, so after a restart only a stop still in effect is seen; a stop that ended during the restart is lost and its round counts.
 */
async function readStop(deps: ShepherdDeps, watch: MachineStopWatch | undefined, since: number, signal: AbortSignal): Promise<StopResult> {
  const reason = watch && (watch.stoppedSince(since) ?? watch.sample());
  if (watch === undefined || reason === undefined) return { kind: "clear" };
  const lift = await awaitLift(watch, { now: deps.now, sleep: deps.sleep, pollMs: deps.pollMs ?? DEFAULT_POLL_MS }, signal);
  return { kind: "stopped", reason, lifted: lift.lifted };
}

/** With no watch wired the step answers `clear`, so a silent reviewer is a timeout as before. */
export const reviewStopRoute = (deps: ShepherdDeps, watch: MachineStopWatch | undefined): StepRoute =>
  codeRoute(REVIEW_STOP_STEP, deps.now, (raw: unknown, signal) => readStop(deps, watch, StopInputSchema.parse(raw).since, signal));

/**
 * A dispatched reviewer that wrote a verdict below the floor gave no verdict. Any other silence is a timeout, unless the machine
 * stop held while it ran and has since lifted: that round is `throttled`, and the same head is reviewed again.
 */
export async function dispatchedNone(ctx: WorkflowContext, head: string, since: number, reason: unknown): Promise<Verdict> {
  const said = typeof reason === "string" ? { reason } : {};
  if (reason === DEPTH_FLOOR_REASON) return { kind: "none", cause: "no-verdict", ...said };
  const stop = await step(ctx, `${REVIEW_STOP_STEP}:${head}`, { head, since }, StopRead);
  if (stop.kind === "stopped" && stop.lifted) return { kind: "none", cause: "throttled", reason: `the machine stop held while the reviewer ran (${stop.reason})` };
  return { kind: "none", cause: "timeout", ...said };
}
