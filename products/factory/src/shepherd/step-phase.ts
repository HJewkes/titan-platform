import { z } from "zod";
import { stepIdMatches } from "../definition.js";

/** The phases a Shepherd run moves through, as `shepherd.list` and `shepherd.timeline` report them; TP-466 section 2 pins them for the UI. */
const PHASES = ["awaiting-pr", "ci", "fixing", "review", "awaiting-approval", "merging", "post-merge", "done", "failed", "cancelled"] as const;

export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

/** A step family to its phase, matched the way `stepIdMatches` matches declarations; an undeclared id reads as `ci` so a new step never breaks a view. */
const STEP_PHASE: Readonly<Record<string, Phase>> = {
  "sh-await-pr": "awaiting-pr",
  "land-rules": "ci",
  "ci-wait": "ci",
  "update-branch": "ci",
  rerun: "ci",
  "sh-freeze-hold": "ci",
  "sh-freeze-wait": "ci",
  "sh-wake-implementer": "fixing",
  "sh-wake-fix-first": "fixing",
  "sh-repair": "fixing",
  "sh-flake-check": "fixing",
  "sh-exit-notice": "fixing",
  "await-new-head": "fixing",
  "sh-await-new-head": "fixing",
  "sh-park": "review",
  "sh-review-intent": "review",
  "sh-review": "review",
  "sh-late-verdict": "review",
  "sh-correct-verdict": "review",
  "sh-release-preflight": "review",
  "sh-observe": "review",
  "sh-merge-evidence": "review",
  "sh-publish-review": "review",
  "sh-carry": "review",
  "sh-carry-scope": "review",
  "sh-carry-seat": "review",
  "sh-remerge": "review",
  "sh-approval-carry": "awaiting-approval",
  "sh-await-verdict": "review",
  "sh-policy": "review",
  "sh-g10-release": "review",
  "merge-policy": "awaiting-approval",
  "approve-merge": "awaiting-approval",
  "ci-failed": "awaiting-approval",
  "sh-sent-back": "awaiting-approval",
  "sh-conflict-check": "awaiting-approval",
  "stuck-behind": "awaiting-approval",
  "sh-seat-notice": "awaiting-approval",
  "merge-settle": "merging",
  merge: "merging",
  "sh-train-leave": "merging",
  "sh-landed": "post-merge",
  "sh-main-ci": "post-merge",
  "sh-redeploy": "post-merge",
  "main-red": "post-merge",
  "main-ci-timeout": "post-merge",
  "main-red-again": "post-merge",
  "main-frozen": "post-merge",
  "sh-unfreeze": "post-merge",
  "sh-thaw": "post-merge",
  "sh-stopped": "post-merge",
  "after-stages": "post-merge",
  "sh-freeze": "post-merge",
  "sh-file-fix-task": "post-merge",
  "sh-spawn-fixer": "post-merge",
  "sh-cleanup": "post-merge",
};

export function stepPhase(stepId: string): Phase {
  const family = Object.keys(STEP_PHASE).find((id) => stepIdMatches(id, stepId));
  return family === undefined ? "ci" : STEP_PHASE[family]!;
}
