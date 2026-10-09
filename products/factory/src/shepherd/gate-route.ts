import type { StepResult, StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { onCiFailed, rerunsFirst, type LandPrState } from "../workflows/land-pr.js";
import { codeRoute, step, type LandOutcome } from "../workflows/land.js";
import { failureOf } from "./error-class.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import { awaitNewHead, sentBackGate, type GateRun } from "./gates.js";

/**
 * Only owner approvals open an owner gate: approve-merge under an owner-gate or visual policy, one-way items, and holds
 * that need the owner. These three are seat work. The registering seat gets a notice and Shepherd takes the default
 * action; the owner gate opens only when no notice went out. A review round's Ship pick at one head is the owner's
 * merge approval there too, but it answers approve-merge only through `roundMergeDecisions` once the gate is open; an
 * answer before the gate opens would join approval carry's wrapper in `reviewingContext`.
 */
const SEAT_GATES = ["ci-failed", "sh-sent-back", "stuck-behind"] as const;
type SeatGate = (typeof SEAT_GATES)[number];

const SEAT_NOTICE_STEP = "sh-seat-notice";
export const SEAT_NOTICE_STEPS: readonly StepDeclaration[] = [{ id: SEAT_NOTICE_STEP, kind: "dispatch" }];

const WAITS = "The run waits for a new head, with no owner gate.";
const NEXT: Record<SeatGate, string> = {
  "ci-failed": `${WAITS} Next: start a fix round (resume the implementer, or start a successor on the PR's branch), push a fix yourself, or close the PR to end the run.`,
  "sh-sent-back": `${WAITS} Next: start a fix round (resume the implementer, or start a successor on the PR's branch), push a fix yourself, or close the PR to end the run.`,
  "stuck-behind": "Shepherd runs update-branch again now, with no owner gate. If the PR keeps falling behind, land it in a quieter window or close it to end the run.",
};

const SeatNoticeInput = z.object({ repo: z.string().min(1), pr: z.number().int().positive(), headSha: z.string().min(1), gate: z.enum(SEAT_GATES), why: z.string() });
type SeatNoticeInput = z.infer<typeof SeatNoticeInput>;

const SeatNoticeResult = z.looseObject({ sent: z.boolean(), detail: z.string(), seat: z.string().optional() });
type SeatNoticeResult = z.infer<typeof SeatNoticeResult>;

function seatNoticeText({ repo, pr, headSha, gate, why }: SeatNoticeInput): string {
  return [`Shepherd: ${repo}#${pr} at head ${headSha}: ${why}.`, NEXT[gate]].join("\n");
}

/** Never throws: no ports, no single seat, or a failed send records `sent: false`, and the run takes the owner gate. */
async function sendSeatNotice(ports: ExitNoticePorts | undefined, input: SeatNoticeInput): Promise<SeatNoticeResult> {
  if (ports === undefined) return { sent: false, detail: "no seat notice is wired" };
  let seat: string | undefined;
  try {
    seat = ports.seatFor(input.repo);
    if (seat === undefined) return { sent: false, detail: `no single seat owns ${input.repo}` };
    await ports.send(seat, seatNoticeText(input));
    return { sent: true, seat, detail: `told ${seat}` };
  } catch (error) {
    return { sent: false, ...(seat && { seat }), detail: `the seat notice failed: ${failureOf(error)}` };
  }
}

export const seatNoticeRoute = (now: () => number, ports: ExitNoticePorts | undefined): StepRoute =>
  codeRoute(SEAT_NOTICE_STEP, now, async (raw: unknown) => sendSeatNotice(ports, SeatNoticeInput.parse(raw)));

/** What a seat notice came to; undefined means none was tried. */
type Told = { sent: boolean; detail: string } | undefined;

/** The one route for seat work: the seat's notice, then the default action, or the owner gate naming why no notice went out. */
export async function seatOrGate<T>(tell: () => Promise<Told>, action: () => Promise<T>, gate: (unsent: string) => Promise<T>): Promise<T> {
  const told = await tell();
  if (told?.sent === true) return action();
  return gate(told === undefined ? "" : ` (${told.detail})`);
}

/** Gates and heads a seat was told about, per run; a replay of the run's notice steps rebuilds the set. */
const noticed = new WeakMap<object, Set<string>>();

/**
 * A run recorded before this step went straight to the gate. Where the record continues, only a recorded notice means
 * noticing; where it ends, a run paused on the gate keeps it.
 */
function recordedWithoutNotice(ctx: WorkflowContext, gate: SeatGate): boolean {
  const next = ctx.historyNext();
  if (next !== undefined) return !stepIdMatches(SEAT_NOTICE_STEP, next);
  const paused = ctx.resumedGate();
  return paused !== undefined && stepIdMatches(gate, paused);
}

/** One recorded seat message per run, gate and head; undefined means the owner gate opens with no notice tried. */
export async function noticeGate(run: GateRun, gate: SeatGate, headSha: string, why: string): Promise<Told> {
  const told = noticed.get(run.ctx) ?? noticed.set(run.ctx, new Set()).get(run.ctx)!;
  if (told.has(`${gate}:${headSha}`) || recordedWithoutNotice(run.ctx, gate)) return undefined;
  const result = await step(run.ctx, SEAT_NOTICE_STEP, { ...run.target, headSha, gate, why }, SeatNoticeResult);
  if (result.sent) told.add(`${gate}:${headSha}`);
  return result;
}

const STUCK_BEHIND_QUESTION = / Retry or abandon\?$/;

/**
 * Land opens stuck-behind from inside its round, so the seat route wraps `assisted`: a told seat answers retry, which
 * runs update-branch again with a fresh budget. `head` is the head the run last read.
 */
export function routingStuckBehind(run: GateRun, head: () => string | undefined, assisted: WorkflowContext["assisted"]): WorkflowContext["assisted"] {
  return async (stepId, prompt, options) => {
    const headSha = head();
    if (!stepIdMatches("stuck-behind", stepId) || headSha === undefined) return assisted(stepId, prompt, options);
    const why = prompt.replace(STUCK_BEHIND_QUESTION, "");
    return seatOrGate(
      () => noticeGate(run, "stuck-behind", headSha, why),
      async (): Promise<StepResult> => ({ stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: { decision: "retry" } }),
      () => assisted(stepId, prompt, options),
    );
  };
}

type RedHead = Extract<LandOutcome, { kind: "ci-failed" }>;

/** A red no fixer took: a transient one reruns first, as in land-pr; any other is the seat's fix round. Undefined lands the next round. */
export function ciFailedRoute(run: GateRun & { state: LandPrState }, red: RedHead): Promise<LandOutcome | undefined> {
  if (rerunsFirst(red, run.state)) return onCiFailed(run.ctx, run.target, red, run.state);
  const checks = red.failing.map((check) => `${check.name} (${check.conclusion ?? "no conclusion"})`).join(", ") || "no failing check named";
  return seatOrGate(
    () => noticeGate(run, "ci-failed", red.headSha, `CI failed (${checks}) and no fixer took the ci-red wake`),
    () => awaitNewHead(run, red.headSha),
    (unsent) => onCiFailed(run.ctx, run.target, red, run.state, unsent),
  );
}

/** A send-back no agent took is the seat's fix round; undefined lands the next round. */
export function unhandledSendBack(run: GateRun, kind: string, headSha: string): Promise<LandOutcome | undefined> {
  return seatOrGate(
    () => noticeGate(run, "sh-sent-back", headSha, `the review said ${kind}, and no agent took the wake`),
    () => awaitNewHead(run, headSha),
    (unsent) => {
      const prompt = `The review of PR #${run.target.pr} in ${run.target.repo} at head ${headSha} said ${kind}, and no agent took the wake${unsent}. Await a new head or abandon?`;
      return sentBackGate(run, headSha, prompt, `a human abandoned the PR after a ${kind} review`);
    },
  );
}
