import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";

export const RELEASE_AUTHOR_STEP = "sh-release-author";

/**
 * True only when GitHub's activity list for `branch` shows `releaseAppLogin`, the release App's `<slug>[bot]` login,
 * pushing the branch to `head`. Anyone who can push to changesets' branch can push a release-only head, and a commit's
 * author login comes from an email the pusher writes, so only the push's own actor shows the App made it (TP-5606).
 * No login configured, no move to `head` in the list, another actor, or a failed read is false: the owner is asked fresh.
 */
export async function releasePushed(port: GitHubPort, target: { repo: RepoSlug; branch: string; head: string }, releaseAppLogin: string | undefined): Promise<boolean> {
  if (!releaseAppLogin) return false;
  try {
    const move = (await port.refActivity(target.repo, target.branch)).find((entry) => entry.after === target.head);
    return move?.actor != null && move.actor.toLowerCase() === releaseAppLogin.toLowerCase();
  } catch {
    return false;
  }
}

interface AuthorInput {
  repo: RepoSlug;
  branch: string;
  head: string;
}

const AuthorResult = z.looseObject({ head: z.string(), released: z.boolean() });

export function releaseAuthorRoute(deps: { port: GitHubPort; now: () => number; releaseAppLogin?: string }): StepRoute {
  return codeRoute(RELEASE_AUTHOR_STEP, deps.now, async (input: AuthorInput) => ({ head: input.head, released: await releasePushed(deps.port, input, deps.releaseAppLogin) }));
}

/** Recorded per head, so a replay reads the answer the carry was decided on. */
export async function releaseAuthorStep(ctx: WorkflowContext, target: AuthorInput): Promise<boolean> {
  return (await step(ctx, `${RELEASE_AUTHOR_STEP}:${target.head}`, target, AuthorResult)).released;
}
