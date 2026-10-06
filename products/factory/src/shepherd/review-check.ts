/**
 * The `shepherd/review` check run for one review outcome at one head.
 *
 * Adapted from VNX `scripts/lib/forge_gate_publisher.py` (L19-L25, L355-L443),
 * https://github.com/Vinix24/vnx-orchestration. Copyright (c) 2026 Vincent van Deth.
 * Used under the MIT License; the full notice is in NOTICE at the repository root.
 *
 * On a required check GitHub counts `neutral` and `skipped` as satisfied, so the conclusion type has neither. A review
 * that could not speak blocks with `action_required`, and `success` is kept for a proven MERGE at this exact head.
 */
import type { ReviewOutcome } from "./route-table.js";

export type ReviewConclusion = "success" | "failure" | "action_required";

export interface ReviewCheckInput {
  outcome: ReviewOutcome;
  /** The head the verdict is about; for `head-moved`, the head that was reviewed. */
  verdictHead?: string;
  /** Where the run is posted: the PR's current head. */
  head: string;
  /** A success would let GitHub merge past Shepherd's other guards, so an armed auto-merge blocks it. */
  autoMergeArmed: boolean;
  /** Set for the Version Packages PR, whose preflight stands in for the reviewer. */
  releaseBlockers?: number;
}

interface ReviewCheck {
  headSha: string;
  conclusion: ReviewConclusion;
  title: string;
  summary: string;
}

type NoVerdictOutcome = Exclude<ReviewOutcome, "MERGE" | "FIX_FIRST" | "head-moved">;

const NO_VERDICT: Record<NoVerdictOutcome, string> = {
  "no-verdict": "The reviewer gave no verdict at this head.",
  timeout: "The wait for the reviewer's verdict ran out.",
  "external-hold": "The hold's reviewer has not answered.",
  "not-started": "No reviewer started at this head.",
};

const short = (sha: string): string => sha.slice(0, 12);

export function reviewCheck(input: ReviewCheckInput): ReviewCheck {
  const { outcome, head, verdictHead } = input;
  const at = (conclusion: ReviewConclusion, title: string, summary: string): ReviewCheck => ({ headSha: head, conclusion, title, summary });
  if (outcome === "FIX_FIRST") return at("failure", `FIX_FIRST at ${short(head)}`, "The review asked for changes at this head.");
  if (outcome !== "MERGE" && outcome !== "head-moved") return at("action_required", `No verdict at ${short(head)} (${outcome})`, NO_VERDICT[outcome]);
  if (outcome === "head-moved" || verdictHead !== head) {
    const reviewed = verdictHead ? short(verdictHead) : "an unknown head";
    return at("action_required", `Reviewed ${reviewed}, not ${short(head)}`, `The verdict is about ${reviewed}; this head has not been reviewed.`);
  }
  if (input.autoMergeArmed) return at("action_required", `MERGE at ${short(head)} held: auto-merge is armed`, "Disarm GitHub auto-merge so Shepherd's guards decide the merge.");
  const blockers = input.releaseBlockers;
  if (blockers !== undefined && blockers !== 0) return at("action_required", `Release preflight at ${short(head)}: ${blockers} blockers`, "The release preflight found blockers at this head.");
  return at("success", `MERGE at ${short(head)}`, blockers === undefined ? "The review passed at this exact head." : "The release preflight passed at this exact head.");
}
