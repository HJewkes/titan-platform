import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { redactForEvidence } from "../redact.js";
import type { StepRoute } from "../routed-runner.js";
import type { HoldLookup } from "./store.js";

export const HOLD_POLL_MS = 10_000;

export class MergeHeldError extends Error {
  override readonly name = "MergeHeldError";
}

/** The port handed to `landRoutes`: its merge refuses a held PR, and an unregistered PR passes straight through. */
export function holdingPort(port: GitHubPort, holds: () => HoldLookup): GitHubPort {
  return {
    ...port,
    merge: async (repo, pr, sha, method) => {
      const reason = holds().heldReason(repo, pr);
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
export function waitWhileHeld(route: StepRoute, holds: () => HoldLookup, timing: HoldTiming): StepRoute {
  return {
    ...route,
    runner: {
      run: async (input) => {
        try {
          await untilReleased(holds, JSON.parse(input.prompt) as MergeTarget, input.signal, timing);
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

async function untilReleased(holds: () => HoldLookup, target: MergeTarget, signal: AbortSignal, timing: HoldTiming): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    if (holds().heldReason(target.repo, target.pr) === undefined) return;
    await timing.sleep(timing.pollMs ?? HOLD_POLL_MS, signal);
  }
}
