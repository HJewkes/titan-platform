import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "@titan-design/workflow";
import { codeRoute } from "../workflows/land.js";

export const FLAKE_CHECK_STEP = "sh-flake-check";
export const FLAKE_CHECK_STEPS: readonly StepDeclaration[] = [{ id: FLAKE_CHECK_STEP, kind: "dispatch" }];

export const FlakeCheckResult = z.looseObject({ outside: z.boolean(), detail: z.string() });

export interface FlakeCheckInput {
  repo: RepoSlug;
  pr: number;
  headSha: string;
  failing: readonly { name: string }[];
}

const LOG_LINES = 1_000;
/** A vitest failure line: `FAIL  path/to/file.test.ts > suite > case`. */
const FAIL_LINE = /\bFAIL\b.*?([\w@.\-/]+\.(?:test|spec)\.[cm]?[jt]sx?)/;

/** The test files a job's log reports failing; empty when the log names none. */
export function failingTestFiles(log: string): string[] {
  return [...new Set(log.split("\n").flatMap((line) => FAIL_LINE.exec(line)?.[1] ?? []))];
}

/**
 * True only when every failing job reports failing test files and none of them is a file the PR changed, so the red
 * says nothing about the PR. A failure that names no test file, or a file list GitHub truncated, never qualifies.
 */
export async function failuresOutsideDiff(port: GitHubPort, input: FlakeCheckInput): Promise<{ outside: boolean; detail: string }> {
  const runs = (await port.latestCheckRuns(input.repo, input.headSha)).filter((run) => input.failing.some((check) => check.name === run.name));
  if (runs.length === 0 || runs.length < input.failing.length) return { outside: false, detail: "a failing check is no longer listed at this head" };
  const logs = await Promise.all(runs.map((run) => port.jobLogTail(input.repo, run.id, LOG_LINES)));
  const perJob = logs.map(failingTestFiles);
  if (perJob.some((files) => files.length === 0)) return { outside: false, detail: "a failing job names no failing test file" };
  const changed = new Set((await port.listPrFiles(input.repo, input.pr)).flatMap((file) => [file.path, ...(file.previousPath === undefined ? [] : [file.previousPath])]));
  const inDiff = perJob.flat().filter((file) => changed.has(file));
  if (inDiff.length > 0) return { outside: false, detail: `failing test files in the PR's diff: ${inDiff.join(", ")}` };
  return { outside: true, detail: `failing test files outside the PR's diff: ${[...new Set(perJob.flat())].join(", ")}` };
}

/** A read that fails is not a verdict: the run takes the gate rather than a rerun. */
export function flakeCheckRoute(port: GitHubPort, now: () => number): StepRoute {
  return codeRoute(FLAKE_CHECK_STEP, now, async (input: FlakeCheckInput) => failuresOutsideDiff(port, input).catch((error: unknown) => ({ outside: false, detail: `the check could not read: ${error instanceof Error ? error.message : String(error)}` })));
}
