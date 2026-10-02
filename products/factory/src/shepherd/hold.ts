import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { redactForEvidence } from "../redact.js";
import type { StepRoute } from "@titan-design/workflow";
import { codeRoute } from "../workflows/land.js";
import type { FreezeGuard } from "./freeze.js";
import type { HoldLookup } from "./store.js";

export const HOLD_POLL_MS = 10_000;

export class MergeHeldError extends Error {
  override readonly name = "MergeHeldError";
}

/** Why a merge of `repo#pr` must wait, read fresh; a PR merged or closed elsewhere has nothing left to wait for, and a failed read throws and refuses. */
export type HeldCheck = (repo: RepoSlug, pr: number) => Promise<string | undefined>;

/** The first guard that names a reason decides; later guards are not read. */
export function firstReason(...guards: readonly FreezeGuard[]): FreezeGuard {
  return {
    async reason(port, repo, pr, baseRef) {
      for (const guard of guards) {
        const reason = await guard.reason(port, repo, pr, baseRef);
        if (reason !== undefined) return reason;
      }
      return undefined;
    },
  };
}

export function heldCheck(port: GitHubPort, holds: () => HoldLookup, freeze?: FreezeGuard): HeldCheck {
  return async (repo, pr) => {
    const lookup = holds();
    const { headRef, baseRef, state } = await port.getPr(repo, pr);
    if (state !== "open") return undefined;
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
  now?: () => number;
}

/** What the merge step answers after a wait: no merge, so land reads CI again, since the base may have moved while it was held. */
const AFTER_HOLD = { done: false, skipped: "held", mergeSha: "" };

/** Wraps the `merge` route so a held PR waits for release, abort-safe, instead of failing on the port's refusal. */
export function waitWhileHeld(route: StepRoute, held: HeldCheck, timing: HoldTiming): StepRoute {
  const afterHold = codeRoute(route.match, timing.now ?? Date.now, async () => AFTER_HOLD);
  return {
    ...route,
    runner: {
      run: async (input) => {
        let waited: boolean;
        try {
          waited = await untilReleased(held, JSON.parse(input.prompt) as MergeTarget, input.signal, timing);
        } catch (error) {
          return { ok: false, error: redactForEvidence(error instanceof Error ? error.message : String(error)), retryable: false };
        }
        return (waited ? afterHold : route).runner.run(input);
      },
    },
  };
}

interface MergeTarget {
  repo: RepoSlug;
  pr: number;
}

/** True when the PR was held at least once before its release. */
async function untilReleased(held: HeldCheck, target: MergeTarget, signal: AbortSignal, timing: HoldTiming): Promise<boolean> {
  for (let waited = false; ; waited = true) {
    signal.throwIfAborted();
    if ((await held(target.repo, target.pr)) === undefined) return waited;
    await timing.sleep(timing.pollMs ?? HOLD_POLL_MS, signal);
  }
}
