import type { GitHubPort, PullRequest } from "@titan-design/github";
import { z } from "zod";
import { mergeWithMessage, type MergeInput } from "./land-merge-message.js";
import type { PrReads } from "./pr-snapshot.js";

export interface BaseCheckInput {
  repo: string;
  pr: number;
  /** The run's policy lets the merge go into a base that is not the repo's default branch. */
  featureBase: boolean;
}

export const BaseCheckResult = z.looseObject({ base: z.string(), defaultBranch: z.string(), allowed: z.boolean(), reason: z.string() });

type BaseCheck = z.infer<typeof BaseCheckResult>;

/**
 * Read live, never from the snapshot, because the merge that follows lands on whatever base the PR names. A PR merged
 * or closed elsewhere is allowed: the merge step reads that and lands nothing.
 */
export async function checkBase(port: GitHubPort, input: BaseCheckInput): Promise<BaseCheck> {
  const pr = await port.getPr(input.repo, input.pr);
  const defaultBranch = await port.defaultBranch(input.repo);
  const settled = pr.merged || pr.state !== "open";
  const allowed = settled || pr.baseRef === defaultBranch || input.featureBase;
  return { base: pr.baseRef, defaultBranch, allowed, reason: allowed ? `base ${pr.baseRef} allowed` : refusedBase(pr.baseRef, defaultBranch) };
}

function refusedBase(base: string, defaultBranch: string): string {
  return `waiting for a retarget: the base is ${base}, not the default branch ${defaultBranch}, and the run's policy merges only into ${defaultBranch}`;
}

export interface BaseWaitInput {
  repo: string;
  pr: number;
  base: string;
  headSha: string;
}

export const BaseWaitResult = z.looseObject({ base: z.string().nullable(), headSha: z.string().nullable() });

interface BaseWaitTiming {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
}

/**
 * No deadline: a refused base waits on a person, and expiry would fail the run. Ends once the base or the head moves
 * or the PR leaves open, and land then reads CI and checks the base again. A failed read is polled again.
 */
export async function waitForRetarget(reads: PrReads, input: BaseWaitInput, timing: BaseWaitTiming, signal: AbortSignal): Promise<z.infer<typeof BaseWaitResult>> {
  for (;;) {
    const pr = await reads.getPr(input.repo, input.pr).catch(() => undefined);
    if (pr && waitIsOver(pr, input)) return { base: pr.baseRef, headSha: pr.headSha };
    await timing.sleep(timing.pollMs, signal);
  }
}

function waitIsOver(pr: PullRequest, input: BaseWaitInput): boolean {
  return pr.baseRef !== input.base || pr.headSha !== input.headSha || pr.merged || pr.state !== "open";
}

/** The merge input plus the base `base-check` allowed; absent on a step recorded before the field, which allows only the default branch. */
export interface BaseMergeInput extends MergeInput {
  base?: string;
}

/** A base retargeted after `base-check` skips the merge, so land reads CI and checks the new base before any write. */
export async function mergeOnAllowedBase(port: GitHubPort, input: BaseMergeInput) {
  const pr = await port.getPr(input.repo, input.pr);
  const allowed = input.base ?? (await port.defaultBranch(input.repo));
  if (pr.state === "open" && !pr.merged && pr.baseRef !== allowed) return { done: false as const, skipped: "base-changed", mergeSha: "" };
  return mergeWithMessage(port, input);
}
