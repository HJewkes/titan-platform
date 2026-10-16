import { dataFence } from "@titan-design/agent-dispatch";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { MAX_NOTE_CHARS } from "../gate-answer-check.js";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step, type LandOutcome } from "../workflows/land.js";

/** Records, per approve-merge gate, whether it offers the owner `send-back`. */
const SEND_BACK_OFFER_STEP = "sh-send-back-offer";
export const OWNER_SEND_BACK_STEPS: readonly StepDeclaration[] = [{ id: SEND_BACK_OFFER_STEP, kind: "dispatch", orphanSafe: true }];
/** What an unhandled owner send-back is called on the seat's sent-back gate. */
export const OWNER_SEND_BACK_KIND = "SEND_BACK from the owner";

const OWNER_SEND_BACK = "OWNER_SEND_BACK";
const OfferResult = z.looseObject({ offered: z.boolean() });
const OwnerSendBackPayload = z.looseObject({ kind: z.literal(OWNER_SEND_BACK), text: z.string() });

type SentBack = Extract<LandOutcome, { kind: "stopped" }> & { reason: "sent-back" };

/**
 * The flag is recorded before each gate, so a replay rebuilds the schema the live gate was opened with whatever the
 * config reads now. A record that goes on to any other step predates this one, and its gate never offered send-back.
 */
export function sendBackOffer(): (ctx: WorkflowContext) => Promise<boolean> {
  let asked = 0;
  return async (ctx) => {
    const stepId = `${SEND_BACK_OFFER_STEP}:${asked++}`;
    const next = ctx.historyNext();
    if (next !== undefined && !next.startsWith(SEND_BACK_OFFER_STEP)) return false;
    return (await step(ctx, stepId, {}, OfferResult)).offered;
  };
}

/** `consoleAnswers` is `shepherd.consoleAnswers` being configured: the console's Ship route is the one path that sends back. */
export const sendBackOfferRoute = (deps: { now: () => number; consoleAnswers?: boolean }): StepRoute =>
  codeRoute(SEND_BACK_OFFER_STEP, deps.now, async () => ({ offered: deps.consoleAnswers === true }));

export const isSentBack = (outcome: LandOutcome): outcome is SentBack => outcome.kind === "stopped" && outcome.reason === "sent-back";

/** The review wake's payload: land's `sent-back` stop carries the owner's note as its detail. */
export const ownerSendBack = (outcome: SentBack): z.infer<typeof OwnerSendBackPayload> => ({ kind: OWNER_SEND_BACK, text: outcome.detail });

/** The owner's own words go to the fixer whole, fenced as data like any review's findings; no reviewer verdict stands behind them. */
export function ownerSendBackWake(headSha: string, payload: unknown): { reason: string; payload: string } | undefined {
  const sent = OwnerSendBackPayload.safeParse(payload);
  if (!sent.success) return undefined;
  const reason = `The owner sent head ${headSha} back at the approve-merge gate instead of merging it. Their note follows: address it, and say in your final message what you changed.`;
  return { reason, payload: dataFence("owner note", sent.data.text) };
}

/** What the owner's own gate says when no agent took the wake: plain words, the PR and head, and the capped, fenced note. */
export function ownerSentBackPrompt(target: { repo: string; pr: number }, headSha: string, note: string, unsent: string): { prompt: string; situation: string } {
  const situation = `The owner sent PR #${target.pr} in ${target.repo} back at head ${headSha} instead of merging it, and no agent took the fix. A new head that addresses the owner's note is needed${unsent}.`;
  const shown = [...note].slice(0, MAX_NOTE_CHARS).join("");
  return { situation, prompt: `${situation} Wait for a new head or abandon?\n${dataFence("owner note", shown)}` };
}
