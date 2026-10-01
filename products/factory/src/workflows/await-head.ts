import type { GitHubPort, PullRequest, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "@titan-design/workflow";
import { codeRoute, sleep } from "./land.js";

export const AWAIT_HEAD_POLL_MS = 30_000;

/** The pull request and the head a human saw fail; the wait ends once the PR shows any other head. */
export interface AwaitHeadTarget {
  repo: RepoSlug;
  pr: number;
  headSha: string;
}

export interface AwaitHeadTiming {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
}

/**
 * Block until the PR's head differs from `target.headSha` or the PR is no longer open, and return that read. No
 * timeout, because a fix can take days; a failed read is polled again, and `signal` aborts the wait between polls.
 */
export async function awaitNewHead(port: GitHubPort, target: AwaitHeadTarget, signal: AbortSignal, timing: AwaitHeadTiming = {}): Promise<PullRequest> {
  const pause = timing.sleep ?? sleep;
  for (;;) {
    signal.throwIfAborted();
    const pr = await port.getPr(target.repo, target.pr).catch(() => undefined);
    if (pr && (pr.headSha !== target.headSha || pr.state !== "open")) return pr;
    await pause(timing.pollMs ?? AWAIT_HEAD_POLL_MS, signal);
  }
}

export const AWAIT_HEAD_STEPS: readonly StepDeclaration[] = [{ id: "await-new-head", kind: "dispatch" }];

export const AwaitHeadResult = z.looseObject({ headSha: z.string(), state: z.enum(["open", "closed"]) });

export interface AwaitHeadDeps extends AwaitHeadTiming {
  port: GitHubPort;
  now?: () => number;
}

/** The step reads and never writes, so a crash mid-wait repeats it; `match` lets a caller name its own step family. */
export function awaitNewHeadRoute(deps: AwaitHeadDeps, match = "await-new-head"): StepRoute {
  return codeRoute(match, deps.now ?? Date.now, async (target: AwaitHeadTarget, signal) => {
    const pr = await awaitNewHead(deps.port, target, signal, deps);
    return { headSha: pr.headSha, state: pr.state, merged: pr.merged };
  });
}
