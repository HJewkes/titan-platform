import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "@titan-design/workflow";
import { codeRoute, step, type LandOutcome } from "../workflows/land.js";
import { rerun } from "../workflows/land-pr.js";
import type { WakeRequest } from "./phases.js";
import { sentBackGate, type GateRun } from "./gates.js";

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

const FailingPayload = z.object({ failing: z.array(z.object({ name: z.string(), conclusion: z.string().nullable(), url: z.string(), workflowRunId: z.number().nullable() })) });

/** What a fixer's exit without a push needs: the run's gate context, plus the heads already rerun, which a head gets once. */
export interface ExitRun extends GateRun {
  state: GateRun["state"] & { round: number; reruns: number };
  rerunHeads: Set<string>;
}

/**
 * A fixer that exited with no push gets no second wait. A red whose failing tests the PR did not touch is rerun once
 * at the same head; anything else opens the sent-back gate naming the exit. Undefined from the gate lands the next round.
 */
export async function afterFixerExit(run: ExitRun, kind: WakeRequest["kind"], headSha: string, payload: unknown, reason: string): Promise<"rerun" | LandOutcome | undefined> {
  const red = kind === "ci-red" && !run.rerunHeads.has(headSha) ? FailingPayload.safeParse(payload) : undefined;
  if (red?.success) {
    const check = await step(run.ctx, `${FLAKE_CHECK_STEP}:${run.state.round}`, { ...run.target, headSha, failing: red.data.failing }, FlakeCheckResult);
    if (check.outside) {
      run.rerunHeads.add(headSha);
      await rerun(run.ctx, run.target, { kind: "ci-failed", headSha, failing: red.data.failing }, run.state);
      return "rerun";
    }
  }
  const prompt = `The ${kind} wake of PR #${run.target.pr} in ${run.target.repo} at head ${headSha} ended: ${reason}. Await a new head or abandon?`;
  return sentBackGate(run, headSha, prompt, `a human abandoned the PR after the fixer exited without a push at a ${kind} wake`);
}
