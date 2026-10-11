import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute } from "@titan-design/workflow";
import type { FreezeGuard } from "./freeze.js";
import { HOLD_POLL_MS, type HoldTiming } from "./hold.js";

/** True for a repo where Shepherd reviews, watches CI and notifies, but never writes to a branch; read fresh on every call. */
export type IsAdvisory = (repo: RepoSlug) => boolean;

export class AdvisoryRefused extends Error {
  override readonly name = "AdvisoryRefused";
}

/** Holds every merge of an advisory repo, so its run waits held and status names why instead of failing. */
export function advisoryGuard(isAdvisory: IsAdvisory): FreezeGuard {
  return {
    reason: async (_port, repo) => (isAdvisory(repo) ? `${repo} is advisory: Shepherd reviews and reports but never merges` : undefined),
  };
}

/** Wraps the `update-branch` route so an advisory repo's update waits, abort-safe, until the flag is removed. */
export function advisoryUpdates(route: StepRoute, isAdvisory: IsAdvisory, timing: HoldTiming): StepRoute {
  return {
    ...route,
    runner: {
      run: async (input) => {
        const { repo } = JSON.parse(input.prompt) as { repo: RepoSlug };
        while (isAdvisory(repo)) {
          input.signal.throwIfAborted();
          await timing.sleep(timing.pollMs ?? HOLD_POLL_MS, input.signal);
        }
        return route.runner.run(input);
      },
    },
  };
}

/** The fail-closed backstop under the guard: no merge, branch update or push for an advisory repo reaches GitHub by any route. */
export function advisoryPort(port: GitHubPort, isAdvisory: IsAdvisory): GitHubPort {
  const refuse = (repo: RepoSlug, write: string): void => {
    if (isAdvisory(repo)) throw new AdvisoryRefused(`${repo} is advisory: Shepherd never ${write}`);
  };
  return {
    ...port,
    merge: async (repo, ...rest) => (refuse(repo, "merges"), port.merge(repo, ...rest)),
    updateBranch: async (repo, ...rest) => (refuse(repo, "updates a branch"), port.updateBranch(repo, ...rest)),
    pushEmptyCommit: async (repo, ...rest) => (refuse(repo, "pushes"), port.pushEmptyCommit(repo, ...rest)),
  };
}
