import { CI_UNREAD_LINE, ciUnreadOnly } from "@titan-design/review-panel";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import type { Verdict } from "./phases.js";

/** Records that a FIX_FIRST holding only the CI-unread line was taken as no verdict, so a replay takes it the same way. */
const CI_UNREAD_STEP = "sh-ci-unread";
export const CI_UNREAD_STEPS: readonly StepDeclaration[] = [{ id: CI_UNREAD_STEP, kind: "dispatch" }];
/** A failed-rounds gate reads it after "ended with". */
export const CI_UNREAD_REASON = `a FIX_FIRST whose only item was "${CI_UNREAD_LINE}", which names nothing a fixer can change`;

const CiUnreadRead = z.looseObject({ head: z.string() });

export const ciUnreadRoute = (now: () => number): StepRoute => codeRoute(CI_UNREAD_STEP, now, async (input: { head: string }) => input);

/**
 * A FIX_FIRST whose only item is the CI-unread line names nothing a fixer can change, and Shepherd reviews only a head it
 * read green, so it is no verdict: the same head goes to a fresh reviewer, bounded by the failed-rounds cap. A run whose
 * record continues past this point without the step took the FIX_FIRST before the step existed, so its replay keeps it.
 */
export async function ciUnreadAsNone(ctx: WorkflowContext, head: string, verdict: Verdict): Promise<Verdict> {
  if (verdict.kind !== "FIX_FIRST" || !ciUnreadOnly(verdict.text)) return verdict;
  const stepId = `${CI_UNREAD_STEP}:${head}`;
  const next = ctx.historyNext();
  if (next !== undefined && !stepIdMatches(stepId, next)) return verdict;
  await step(ctx, stepId, { head }, CiUnreadRead);
  return { kind: "none", cause: "no-verdict", reason: CI_UNREAD_REASON };
}
