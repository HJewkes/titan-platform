import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import { releasePushed } from "./release-diff.js";

export const RELEASE_AUTHOR_STEP = "sh-release-author";

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
