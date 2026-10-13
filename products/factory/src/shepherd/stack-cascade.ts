import type { GitHubPort, PullRequest, RepoSlug } from "@titan-design/github";
import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches } from "../definition.js";
import { requestUpdate } from "../workflows/land-update.js";
import type { PrSnapshot } from "../workflows/pr-snapshot.js";
import { AWAIT_NEW_HEAD_STEP } from "./wake.js";

/** Past this many fix rounds a parent is churning, so agent-chat stacks no new child on it; existing children keep cascading. */
const STACK_FREEZE_ROUNDS = 2;

/** A parent run whose head moved: `previousHead` is the head it held before the fix round, `newHead` the one it holds now. */
export interface CascadeInput {
  repo: RepoSlug;
  parentPr: number;
  /** The parent's head branch, which each stacked child names as its base. */
  parentHeadRef: string;
  previousHead: string;
  newHead: string;
}

/** A child whose base would not merge in: its implementer is woken with `reason`, and its head is unchanged. */
export interface ChildWake {
  repo: RepoSlug;
  pr: number;
  headSha: string;
  reason: string;
}

interface CascadeDeps {
  port: GitHubPort;
  /** Where the children are read from; absent means the port's open list. */
  snapshot?: PrSnapshot;
  /** The child's fix-wake; the cascade itself wakes no agent for a child that updated cleanly. */
  wakeChild: (wake: ChildWake) => Promise<void>;
}

type ChildCascade = { pr: number; outcome: "updated" } | { pr: number; outcome: "conflict"; reason: string } | { pr: number; outcome: "skipped"; detail: string };

/** A child is stacked on the parent when its base is the parent's head branch in the same repo; a fork's PR is never updated. */
async function stackedChildren(deps: CascadeDeps, input: CascadeInput): Promise<PullRequest[]> {
  const open = deps.snapshot ? await deps.snapshot.openPrs(input.repo) : await deps.port.listOpenPrs(input.repo);
  const sameRepo = (pr: PullRequest) => pr.headRepo?.toLowerCase() === input.repo.toLowerCase();
  return open.filter((pr) => pr.baseRef === input.parentHeadRef && pr.number !== input.parentPr && sameRepo(pr));
}

const conflictReason = (parentPr: number): string => `parent #${parentPr} moved; merge conflict`;

async function cascadeChild(deps: CascadeDeps, input: CascadeInput, child: PullRequest): Promise<ChildCascade> {
  const write = await requestUpdate(deps.port, { repo: input.repo, pr: child.number, expectedHeadSha: child.headSha });
  if (write === "conflict") {
    const reason = conflictReason(input.parentPr);
    await deps.wakeChild({ repo: input.repo, pr: child.number, headSha: child.headSha, reason });
    return { pr: child.number, outcome: "conflict", reason };
  }
  return write.done ? { pr: child.number, outcome: "updated" } : { pr: child.number, outcome: "skipped", detail: write.skipped };
}

/**
 * Merges the parent's new head into each stacked child by update-branch: a merge commit that fast-forwards the child, so
 * its fork point moves to the parent's new head and its own CI re-runs on the new head. An unchanged head cascades nothing.
 */
export async function cascadeStack(deps: CascadeDeps, input: CascadeInput): Promise<ChildCascade[]> {
  if (input.newHead === input.previousHead) return [];
  const children = await stackedChildren(deps, input);
  const results: ChildCascade[] = [];
  for (const child of children) results.push(await cascadeChild(deps, input, child));
  if (children.length > 0) deps.snapshot?.invalidate(input.repo);
  return results;
}

const NewHead = z.looseObject({ result: z.looseObject({ state: z.literal("open"), exited: z.literal(true).optional(), green: z.literal(true).optional() }) });

/** A fix round is a wake whose wait ended on a pushed head: not on an exit with no push, nor on the same head turning green. */
function fixRounds(run: Pick<WorkflowRun, "stepResults">): number {
  return Object.values(run.stepResults).filter((result) => {
    if (!stepIdMatches(AWAIT_NEW_HEAD_STEP, result.stepId)) return false;
    const parsed = NewHead.safeParse(result.data);
    return parsed.success && parsed.data.result.exited !== true && parsed.data.result.green !== true;
  }).length;
}

export const stackFrozen = (run: Pick<WorkflowRun, "stepResults">): boolean => fixRounds(run) > STACK_FREEZE_ROUNDS;
