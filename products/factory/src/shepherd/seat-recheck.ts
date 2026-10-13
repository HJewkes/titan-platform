import { OwnerBriefSchema, type AwaitVerdictResult } from "@titan-design/review-panel";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { HEAD } from "./await-verdict.js";
import type { SeatHeld, Verdict } from "./phases.js";
import { CiPolicySchema, LocatorSchema } from "./review-schemas.js";
import { SEAT_RECHECK_STEP } from "./take-verdict.js";

const HeldMergeInput = z.object({
  merge: z.object({
    kind: z.literal("verdict"),
    verdict: z.literal("MERGE"),
    head: z.string().regex(HEAD),
    locator: LocatorSchema,
    reviewer: z.object({ agentId: z.string().min(1), sessionId: z.string().min(1) }),
    ownerBrief: OwnerBriefSchema.nullable().optional().catch(null),
    ciPolicy: CiPolicySchema,
  }),
});

/** The recheck's MERGE, as the verdict step recorded it; one that does not read is no verdict, so it can never merge. */
export function heldMerge(raw: unknown): AwaitVerdictResult {
  const read = HeldMergeInput.safeParse(raw);
  if (!read.success) return { kind: "none", reason: "the held MERGE could not be read" };
  const { head, locator, reviewer, ownerBrief, ciPolicy } = read.data.merge;
  return { kind: "verdict", verdict: "MERGE", head, locator, reviewer, ...(ownerBrief !== undefined && { ownerBrief }), ...(ciPolicy && { ciPolicy }) };
}

/** A replay whose record took another step at this head ran before the recheck existed, so it reviews again as it did. */
export function recordsRecheck(ctx: WorkflowContext, head: string): boolean {
  const next = ctx.historyNext();
  return next === undefined || next === `${SEAT_RECHECK_STEP}:${head}`;
}

/** Reviews `headSha` with the MERGE a seat held there last round, and keeps the hold this review leaves for the next one. */
export async function reviewKeepingSeatHold(held: Map<string, SeatHeld>, headSha: string, review: (seatHeld: SeatHeld | undefined) => Promise<Verdict>): Promise<Verdict> {
  const verdict = await review(held.get(headSha));
  if (verdict.kind === "none" && verdict.seatHeld?.head === headSha) held.set(headSha, verdict.seatHeld);
  else held.delete(headSha);
  return verdict;
}
