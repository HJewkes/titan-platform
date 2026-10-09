import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "@titan-design/workflow";
import { codeRoute, step, type LandOutcome } from "../workflows/land.js";
import { rerun } from "../workflows/land-pr.js";
import type { WakeEvidence, WakeRequest } from "./phases.js";
import { awaitNewHead, sentBackGate, type GateRun } from "./gates.js";
import { EXIT_NOTICE_STEPS, exitNoticeRoute, noticeSeat, type ExitNoticePorts } from "./exit-notice.js";
import { seatOrGate } from "./gate-route.js";

const FLAKE_CHECK_STEP = "sh-flake-check";
/** The steps `afterFixerExit` records: the flake check, then the seat notice. */
export const FIXER_EXIT_STEPS: readonly StepDeclaration[] = [{ id: FLAKE_CHECK_STEP, kind: "dispatch" }, ...EXIT_NOTICE_STEPS];

const FlakeCheckResult = z.looseObject({ outside: z.boolean(), detail: z.string() });

interface FlakeCheckInput {
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
function flakeCheckRoute(port: GitHubPort, now: () => number): StepRoute {
  return codeRoute(FLAKE_CHECK_STEP, now, async (input: FlakeCheckInput) => failuresOutsideDiff(port, input).catch((error: unknown) => ({ outside: false, detail: `the check could not read: ${error instanceof Error ? error.message : String(error)}` })));
}

export const fixerExitRoutes = (port: GitHubPort, now: () => number, exitNotice: ExitNoticePorts | undefined): StepRoute[] => [flakeCheckRoute(port, now), exitNoticeRoute(now, exitNotice)];

const FailingPayload = z.object({ failing: z.array(z.object({ name: z.string(), conclusion: z.string().nullable(), url: z.string(), workflowRunId: z.number().nullable() })) });

type ExitRun = GateRun & { state: { round: number; reruns: number } };

/** Heads rerun after a fixer's exit, per run; a head gets one, and a replay of the run's steps rebuilds the set. */
const rerunHeads = new WeakMap<object, Set<string>>();

/**
 * A fixer that exited with no push gets no second wait. A red whose failing tests the PR did not touch is rerun once
 * at the same head, and the round goes on. Otherwise the repo's seat is told once per head and the run waits for a new
 * head; with no seat told, the sent-back gate names the exit. Either way the round leaves through `leave`, which builds
 * the error that ends it.
 */
export async function afterFixerExit(run: ExitRun, kind: WakeRequest["kind"], headSha: string, payload: unknown, exit: { reason: string; wake?: WakeEvidence }, leave: (outcome?: LandOutcome) => Error): Promise<true> {
  const reran = rerunHeads.get(run.ctx) ?? rerunHeads.set(run.ctx, new Set()).get(run.ctx)!;
  const red = kind === "ci-red" && !reran.has(headSha) ? FailingPayload.safeParse(payload) : undefined;
  if (red?.success) {
    const check = await step(run.ctx, `${FLAKE_CHECK_STEP}:${run.state.round}`, { ...run.target, headSha, failing: red.data.failing }, FlakeCheckResult);
    if (check.outside) {
      reran.add(headSha);
      await rerun(run.ctx, run.target, { kind: "ci-failed", headSha, failing: red.data.failing }, run.state);
      return true;
    }
  }
  throw await noticeOrGate(run, kind, headSha, exit, `a human abandoned the PR after the fixer exited without a push at a ${kind} wake`, leave);
}

/** A send-back whose successor agent-chat refused takes the same route as an exit with no push: the seat, else the owner. */
export async function afterHeldWake(run: ExitRun, kind: WakeRequest["kind"], headSha: string, held: { reason: string; held: { agent: string } }, leave: (outcome?: LandOutcome) => Error): Promise<never> {
  const exit = { reason: held.reason, wake: { agent: held.held.agent }, held: held.reason };
  throw await noticeOrGate(run, kind, headSha, exit, `a human abandoned the PR after no fixer could start at a ${kind} wake`, leave);
}

/** The run waits for a new head with no gate only once the seat was told; otherwise the sent-back gate names why. */
async function noticeOrGate(run: ExitRun, kind: WakeRequest["kind"], headSha: string, exit: { reason: string; wake?: WakeEvidence; held?: string }, abandoned: string, leave: (outcome?: LandOutcome) => Error): Promise<Error> {
  const tell = async () => {
    const notice = await noticeSeat(run, kind, headSha, exit.wake, exit.held);
    return notice && { sent: notice.sent, detail: `${notice.cause}: ${notice.detail}` };
  };
  const prompt = (unsent: string) => `The ${kind} wake of PR #${run.target.pr} in ${run.target.repo} at head ${headSha} ended: ${exit.reason}${unsent}. Await a new head or abandon?`;
  return seatOrGate(tell, async () => leave(await awaitNewHead(run, headSha)), async (unsent) => leave(await sentBackGate(run, headSha, prompt(unsent), abandoned)));
}
