import type { RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import type { ShepherdDeps } from "./phases.js";
import { headPoll } from "./push-signal.js";
import { applyRegistrationHold } from "./registration-hold.js";

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

/**
 * No timeout, because a PR can take days to open. The branch's PR is looked up on a push to it or once per backstop; a
 * failed read is read again, and the step's signal aborts the wait. The registration hold is placed before the step
 * returns, so the run reaches no merge with its G10 class unread.
 */
async function awaitPr(deps: ShepherdDeps, input: AwaitPrInput, signal: AbortSignal): Promise<object> {
  const read = async () => (await deps.port.findPr(input.repo, input.branch).catch(() => null)) ?? undefined;
  const poll = headPoll({ pushes: deps.pushes, repo: input.repo, branch: input.branch, read });
  for (;;) {
    signal.throwIfAborted();
    const polled = await poll.next();
    const found = polled.read ? polled.pr : undefined;
    if (found && (found.state === "open" || found.merged)) {
      deps.store.get().setPr(input.runId, found.number);
      await applyRegistrationHold(deps.port, deps.store.get(), input.runId);
      return { pr: found.number, headSha: found.headSha };
    }
    await deps.sleep(poll.tickMs, signal);
  }
}

export function awaitPrRoute(deps: ShepherdDeps): StepRoute {
  return codeRoute("sh-await-pr", deps.now, (input: AwaitPrInput, signal) => awaitPr(deps, input, signal));
}
