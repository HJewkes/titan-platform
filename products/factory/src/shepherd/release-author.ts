import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";

export const RELEASE_AUTHOR_STEP = "sh-release-author";

/**
 * True only when GitHub reads `head`'s author as `releaseAppLogin`, the release App's `<slug>[bot]` login. Anyone who
 * can push to changesets' branch can push a release-only head, so only the App's own head may keep or take the owner's
 * answer (TP-5606). No login configured, no linked author, or a failed read is false, and the owner is asked fresh.
 */
export async function releaseAuthored(port: GitHubPort, repo: RepoSlug, head: string, releaseAppLogin: string | undefined): Promise<boolean> {
  if (!releaseAppLogin) return false;
  try {
    const { author } = await port.commitLogins(repo, head);
    return author !== null && author.toLowerCase() === releaseAppLogin.toLowerCase();
  } catch {
    return false;
  }
}

interface AuthorInput {
  repo: RepoSlug;
  head: string;
}

const AuthorResult = z.looseObject({ head: z.string(), released: z.boolean() });

export function releaseAuthorRoute(deps: { port: GitHubPort; now: () => number; releaseAppLogin?: string }): StepRoute {
  return codeRoute(RELEASE_AUTHOR_STEP, deps.now, async ({ repo, head }: AuthorInput) => ({ head, released: await releaseAuthored(deps.port, repo, head, deps.releaseAppLogin) }));
}

/** Recorded per head, so a replay reads the answer the carry was decided on. */
export async function releaseAuthorStep(ctx: WorkflowContext, repo: RepoSlug, head: string): Promise<boolean> {
  return (await step(ctx, `${RELEASE_AUTHOR_STEP}:${head}`, { repo, head }, AuthorResult)).released;
}
