import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepResult, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches } from "../definition.js";
import { step } from "../workflows/land.js";
import { APPROVAL_CARRY_STEP } from "./carry-merge.js";
import { VERSION_PACKAGES_BRANCH, nonReleaseFiles } from "./release.js";
import { releaseAuthorStep, releaseAuthored } from "./release-author.js";

/** The shepherd-release rows that wait only on the owner's word: the preflight at that head found nothing blocking. */
const OWNER_ROWS: ReadonlySet<string> = new Set(["owner-gate", "no-release-grant"]);
const RELEASE_OWNER_GATE = /^Merge PR #\d+ in \S+ at head ([0-9a-f]{40})(?: into \S+)?\? CI is green\. Policy shepherd-release\/(?:owner-gate|no-release-grant):/;
const CARRY_RULE = "release-regenerated";

const MergeAnswer = z.looseObject({ decision: z.literal("merge"), headSha: z.string() });

export const isReleaseOwnerRow = (rowId: string | undefined): boolean => rowId !== undefined && OWNER_ROWS.has(rowId);

/**
 * True when the open PR at `head` is still changesets' own branch in `repo` and every file it changes is one
 * `pnpm version-packages` writes. Each main push re-runs that action, so the old-to-new head delta always holds main's
 * own changes; what the owner approved is the PR's diff, and that is what must still be release-only (TP-5591).
 * The files are read before the head is confirmed, so a list from any head but `head` fails the check. The head must
 * also be the release App's own commit (`releaseAuthored`), since a branch push is open to more than changesets.
 */
export async function regeneratedRelease(port: GitHubPort, repo: RepoSlug, pr: number, head: string, releaseAppLogin: string | undefined): Promise<boolean> {
  try {
    const files = await port.listPrFiles(repo, pr);
    const live = await port.getPr(repo, pr);
    const own = live.headRef === VERSION_PACKAGES_BRANCH && live.headRepo?.toLowerCase() === repo.toLowerCase();
    const releaseOnly = own && live.state === "open" && live.headSha === head && files.length > 0 && nonReleaseFiles(files).length === 0;
    return releaseOnly && (await releaseAuthored(port, repo, head, releaseAppLogin));
  } catch {
    return false;
  }
}

function followedAnswer(ctx: WorkflowContext, fromHead: string, head: string): Promise<StepResult> {
  const stepId = `${APPROVAL_CARRY_STEP}:${head}`;
  return step(ctx, stepId, { decision: "merge", headSha: head, fromHead, rule: CARRY_RULE }, MergeAnswer).then((followed) => ({
    stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: { decision: followed.decision, headSha: followed.headSha },
  }));
}

/**
 * Wraps a release run's `assisted` so the owner's merge answer at one owner-only release gate answers the next one at a
 * regenerated head. That gate opens only once the preflight at the new head passed: head on changesets' branch, every
 * file a release file, manifests changing versions only, every package trusted on npm. A preflight-blocked or
 * no-preflight gate, and any other gate, is asked as before. Any approve-merge gate asked fresh ends the carry, so an
 * answer never skips over a question the owner was asked and did not answer (TP-5596). A head the release App did not
 * author is asked fresh too (TP-5606).
 */
export function followingReleaseApproval(ctx: WorkflowContext, assisted: WorkflowContext["assisted"], repo: RepoSlug): WorkflowContext["assisted"] {
  let approved: string | undefined;
  return async (stepId, prompt, options) => {
    const mergeGate = stepIdMatches("approve-merge", stepId);
    const asked = mergeGate ? RELEASE_OWNER_GATE.exec(prompt)?.[1] : undefined;
    if (asked === undefined) {
      if (mergeGate) approved = undefined;
      return assisted(stepId, prompt, options);
    }
    if (approved !== undefined && approved !== asked && (await releaseAuthorStep(ctx, repo, asked))) return followedAnswer(ctx, approved, asked);
    const answer = await assisted(stepId, prompt, options);
    approved = MergeAnswer.safeParse(answer.data).data?.headSha === asked ? asked : undefined;
    return answer;
  };
}
