import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { redactForEvidence } from "../redact.js";
import type { StepRoute } from "../routed-runner.js";
import type { FreezeGuard } from "./freeze.js";
import type { HoldLookup } from "./store.js";

export const HOLD_POLL_MS = 10_000;

export class MergeHeldError extends Error {
  override readonly name = "MergeHeldError";
}

/** Why a merge of `repo#pr` must wait, read fresh; the PR is read for its head branch, so a failed read throws and refuses. */
export type HeldCheck = (repo: RepoSlug, pr: number) => Promise<string | undefined>;

export function heldCheck(port: GitHubPort, holds: () => HoldLookup, freeze?: FreezeGuard): HeldCheck {
  return async (repo, pr) => {
    const lookup = holds();
    const { headRef, baseRef } = await port.getPr(repo, pr);
    return lookup.heldReason(repo, pr, headRef) ?? (await freeze?.reason(port, repo, pr, baseRef));
  };
}

/** The port handed to `landRoutes`: its merge refuses a held PR, and any PR of a frozen repo but the fix task's; any other PR passes straight through. */
export function holdingPort(port: GitHubPort, holds: () => HoldLookup, freeze?: FreezeGuard): GitHubPort {
  const held = heldCheck(port, holds, freeze);
  return {
    ...port,
    merge: async (repo, pr, sha, method) => {
      const reason = await held(repo, pr);
      if (reason !== undefined) throw new MergeHeldError(`${repo}#${pr} is held: ${reason}`);
      return port.merge(repo, pr, sha, method);
    },
  };
}

export interface HoldTiming {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
}

/** Wraps the `merge` route so a held PR waits for release, abort-safe, instead of failing on the port's refusal. */
export function waitWhileHeld(route: StepRoute, held: HeldCheck, timing: HoldTiming): StepRoute {
  return {
    ...route,
    runner: {
      run: async (input) => {
        try {
          await untilReleased(held, JSON.parse(input.prompt) as MergeTarget, input.signal, timing);
        } catch (error) {
          return { ok: false, error: redactForEvidence(error instanceof Error ? error.message : String(error)), retryable: false };
        }
        return route.runner.run(input);
      },
    },
  };
}

interface MergeTarget {
  repo: RepoSlug;
  pr: number;
}

async function untilReleased(held: HeldCheck, target: MergeTarget, signal: AbortSignal, timing: HoldTiming): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    if ((await held(target.repo, target.pr)) === undefined) return;
    await timing.sleep(timing.pollMs ?? HOLD_POLL_MS, signal);
  }
}
