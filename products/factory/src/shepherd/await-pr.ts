import type { RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import type { ShepherdDeps } from "./phases.js";

export const SH_AWAIT_PR_POLL_MS = 30_000;

const AwaitPrResult = z.looseObject({ pr: z.number().int().positive(), headSha: z.string() });

interface AwaitPrInput {
  repo: RepoSlug;
  branch: string;
  runId: string;
}

/** The PR number for a run registered by branch; the step waits until that branch has an open or merged PR. */
export async function awaitPrStep(ctx: WorkflowContext, repo: RepoSlug, branch: string | undefined): Promise<number> {
  return (await step(ctx, "sh-await-pr", { repo, branch, runId: ctx.runId }, AwaitPrResult)).pr;
}

/** No timeout, because a PR can take days to open; a failed read is polled again, and the step's signal aborts the wait. */
async function awaitPr(deps: ShepherdDeps, input: AwaitPrInput, signal: AbortSignal): Promise<object> {
  for (;;) {
    signal.throwIfAborted();
    const found = await deps.port.findPr(input.repo, input.branch).catch(() => null);
    if (found && (found.state === "open" || found.merged)) {
      deps.store.get().setPr(input.runId, found.number);
      return { pr: found.number, headSha: found.headSha };
    }
    await deps.sleep(deps.pollMs ?? SH_AWAIT_PR_POLL_MS, signal);
  }
}

export function awaitPrRoute(deps: ShepherdDeps): StepRoute {
  return codeRoute("sh-await-pr", deps.now, (input: AwaitPrInput, signal) => awaitPr(deps, input, signal));
}
