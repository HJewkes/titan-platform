import { createHash } from "node:crypto";
import { reviewerBrief, type ReviewerBriefInput } from "../reviewer-brief.js";
import type { ReviewShape } from "../types.js";
import { ADVERSARY_OVERLAY, holdContextLines, type AdversaryHoldContext } from "./adversary.js";
import { PERF_OVERLAY } from "./perf.js";
import { TESTS_OVERLAY, fixProofLines, waivedLines } from "./tests.js";
import { VISUAL_OVERLAY } from "./visual.js";

/** The shapes that carry an overlay; correctness is the base brief itself. */
export type OverlayShape = Exclude<ReviewShape, "correctness">;

export const OVERLAY_SHAPES: readonly OverlayShape[] = ["adversary", "tests", "visual", "perf"];

/**
 * Points at the base brief's test rule rather than restating it, so the host's rule (Shepherd's `suiteRules`) stays the one
 * source and the overlays cannot drift from it.
 */
const CHECK_RULE =
  "Run every check where this brief's test rule below says: builds, typecheck, lint and full suites only through `basement-suite`, in the form that rule gives, and never a full suite in your checkout.";

export interface ShapeBrief {
  /** Stable across edits; `hash` names the variant. */
  id: string;
  shape: OverlayShape;
  overlay: string;
  /** sha256 of `overlay`, so an edited brief is a new variant rather than an in-place change. */
  hash: string;
}

function shapeBriefOf(shape: OverlayShape, lines: readonly string[]): ShapeBrief {
  const overlay = [...lines, CHECK_RULE].join("\n");
  return { id: shape, shape, overlay, hash: createHash("sha256").update(overlay).digest("hex") };
}

/** Ids match `planPanel`'s default brief id per shape. */
export const SHAPE_BRIEFS: Readonly<Record<OverlayShape, ShapeBrief>> = {
  adversary: shapeBriefOf("adversary", ADVERSARY_OVERLAY),
  tests: shapeBriefOf("tests", TESTS_OVERLAY),
  visual: shapeBriefOf("visual", VISUAL_OVERLAY),
  perf: shapeBriefOf("perf", PERF_OVERLAY),
};

export interface ShapeBriefInput extends ReviewerBriefInput {
  /** A `fix-proof/v1 <json>` line for this head; only the tests brief reads it. */
  fixProof?: string;
  /** Why the PR is held for an adversary; only the adversary brief reads it. */
  holdContext?: AdversaryHoldContext;
}

/** The overlay comes first so the base brief's verdict template stays the end of the prompt. */
export function shapeBrief(shape: OverlayShape, input: ShapeBriefInput): string {
  const { fixProof, holdContext, ...base } = input;
  const waived = waivedLines(input.head, input.fixProofWaivedAt).length > 0;
  const extra = shape === "tests" && !waived ? ["", ...fixProofLines(input.head, fixProof)] : shape === "adversary" ? holdContextLines(holdContext) : [];
  return [SHAPE_BRIEFS[shape].overlay, ...extra, "", reviewerBrief(base)].join("\n");
}
