import { isUsageLimit, type AwaitVerdictInput } from "@titan-design/review-panel";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { AWAIT_VERDICT_STEP } from "./await-verdict.js";
import { CORRECT_VERDICT_STEP, Corrected } from "./correct-verdict.js";
import { Awaited } from "./review-schemas.js";
import type { ScopedRereview } from "./review-scope-round.js";
import { scopeViolations, type CheckedHunk } from "./scope-check.js";

/** `shepherd.review.scopeCheck` (TP-3735 S5): `shadow` counts a scoped FIX_FIRST's out-of-range and repeated items, `on` also asks for one correction. */
export type ScopeCheckMode = "off" | "shadow" | "on";

export const SCOPE_CHECK_STEP = "sh-scope-check";
export const SCOPE_CHECK_STEPS: readonly StepDeclaration[] = [{ id: SCOPE_CHECK_STEP, kind: "dispatch" }];

const Mode = z.enum(["shadow", "on"]);
const CheckInput = z.object({
  head: z.string(),
  text: z.string(),
  hunks: z.array(z.object({ path: z.string(), start: z.number().int(), end: z.number().int() })),
  posted: z.array(z.string()),
  mode: Mode,
  corrected: z.literal(true).optional(),
});
/** `at` bounds the correction's reply: the checked verdict was written before it. `kept` is a corrected reply that still broke a rule. */
const Checked = z.looseObject({ kind: z.literal("checked"), untagged: z.number(), repeated: z.number(), at: z.number() });
type CheckedResult = z.infer<typeof Checked>;
type AwaitedResult = z.infer<typeof Awaited>;

/** The pure check as a recorded step, so stats read the counts and a replay takes the same branch. */
export const scopeCheckRoute = (now: () => number): StepRoute =>
  codeRoute(SCOPE_CHECK_STEP, now, async (raw: unknown) => {
    const input = CheckInput.parse(raw);
    const { untagged, repeated } = scopeViolations(input.text, input.hunks, input.posted);
    const kept = input.corrected === true && untagged.length + repeated.length > 0;
    return { kind: "checked", mode: input.mode, untagged: untagged.length, repeated: repeated.length, at: now(), ...(kept && { kept: true }) };
  });

/** What a scoped round's check reads: the fix's ranges, and the open findings the brief carried. */
export interface ScopeRound {
  mode: "shadow" | "on";
  hunks: readonly CheckedHunk[];
  posted: string[];
}

export interface ScopeCheckWiring {
  /** `shepherd.review.scopeCheck`; absent means `off`, and no FIX_FIRST is checked. */
  scopeCheck?: ScopeCheckMode;
}

/** Recorded on the intent like `scopedRereview`, so a replay checks the head as its first run did. */
export const scopeCheckModeOf = (mode: ScopeCheckMode | undefined): { scopeCheck?: "shadow" | "on" } => (mode === "shadow" || mode === "on" ? { scopeCheck: mode } : {});

const IntentRead = z.looseObject({ scopeCheck: Mode.optional() });

/** Only a round whose correctness brief was scoped is checked: a reviewer never told the rules cannot break them. */
export function scopeRoundOf(intent: object, rereview: ScopedRereview | undefined): ScopeRound | undefined {
  const mode = IntentRead.safeParse(intent).data?.scopeCheck;
  if (mode === undefined || rereview?.mode !== "on" || !rereview.scoped) return undefined;
  return { mode, hunks: rereview.scope.hunks, posted: rereview.earlierFindings.map((finding) => finding.text) };
}

/** A reviewer is asked to correct a scoped FIX_FIRST at most this many times per head. */
const MAX_SCOPE_CORRECTIONS = 1;

const FixFirstRead = z.looseObject({ kind: z.literal("verdict"), verdict: z.literal("FIX_FIRST"), text: z.string() });

/** One correction turn in the reviewer's own session, its steps numbered by `turn`; a reply with no verdict reads as `none`. */
async function askScopeCorrection(ctx: WorkflowContext, awaiting: AwaitVerdictInput, checked: CheckedResult, ownerBrief: boolean, turn: number): Promise<AwaitedResult> {
  const malformed = { refusal: checked.untagged > 0 ? "scope_untagged" : "repeated_finding", writtenAt: checked.at };
  const asked = await step(ctx, `${CORRECT_VERDICT_STEP}:${awaiting.head}:scope-${turn}`, { ...awaiting, malformed, ...(ownerBrief && { ownerBrief: true }) }, Corrected);
  if (asked.kind !== "asked") return { kind: "none", reason: asked.reason };
  return step(ctx, `${AWAIT_VERDICT_STEP}:${awaiting.head}:scope-${turn}`, { ...awaiting, dispatchedAt: checked.at, startedAt: asked.startedAt }, Awaited);
}

/**
 * A scoped round's FIX_FIRST is checked before it is routed. Under `on`, a miss gets one correction and the reply is taken as
 * the reviewer wrote it, a MERGE included; a reply that still misses, or none, keeps the verdict and records `kept`. No code
 * here turns a FIX_FIRST into a MERGE.
 */
export async function enforceScope(ctx: WorkflowContext, awaiting: AwaitVerdictInput, awaited: AwaitedResult, round: ScopeRound & { ownerBrief: boolean }, turn = 0): Promise<AwaitedResult> {
  const fixFirst = FixFirstRead.safeParse(awaited).data;
  if (!fixFirst) return awaited;
  const input = { head: awaiting.head, text: fixFirst.text, hunks: round.hunks, posted: round.posted, mode: round.mode, ...(turn > 0 && { corrected: true as const }) };
  const checked = await step(ctx, `${SCOPE_CHECK_STEP}:${awaiting.head}${turn > 0 ? `:reply-${turn}` : ""}`, input, Checked);
  if (round.mode === "shadow" || checked.untagged + checked.repeated === 0 || turn >= MAX_SCOPE_CORRECTIONS) return awaited;
  const reply = await askScopeCorrection(ctx, awaiting, checked, round.ownerBrief, turn + 1);
  if (isUsageLimit(reply)) return reply;
  return enforceScope(ctx, awaiting, reply.kind === "verdict" ? reply : awaited, round, turn + 1);
}
