import { headRegressionObserver } from "../head-guard/head-regression.js";
import type { GitHubPort, PullRequest, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "@titan-design/workflow";
import { readRequiredChecks } from "../required-checks.js";
import { codeRoute, sleep } from "./land.js";
import { requiredChecksPass } from "./land-ci.js";
import { portReads, type PrReads, type PrSnapshot } from "./pr-snapshot.js";
import { headPoll, type PushWatch } from "../shepherd/push-signal.js";
import { errorStatus } from "../narrow.js";

/** The snapshot's pending cadence: an unchanged head's checks are read no more often than a pending head's in the snapshot. */
export const CHECKS_RECHECK_MS = 3 * 60_000;

/** The freeze recheck's cadence: a ci-red head's failing checks are re-weighed against the base no more often than this. */
export const BASE_RED_RECHECK_MS = 5 * 60_000;

/** The pull request and the head a human saw fail; the wait ends once the PR shows any other head. */
export interface AwaitHeadTarget {
  repo: RepoSlug;
  pr: number;
  headSha: string;
  /** The woken fixer; once it has exited with the head unchanged, the wait ends instead of running on. */
  agent?: string;
  /** Set after a red ci-wait: every required check passing at the unchanged head, as after a rerun of the failed jobs, also ends the wait. */
  untilGreen?: boolean;
  /** The red check names the wait was entered with; with an `inheritedRed` hook, a red the base turns out to own also ends the wait. */
  failing?: string[];
  /** The run has made its main-fixed merge-ups, so the `inheritedRed` hook weighs the red as the run's own hold would. */
  mainFixedSpent?: boolean;
}

/**
 * How the wait ended: `exited` when the fixer ended with the head unchanged and the PR open, `green` when the unchanged
 * head's required checks all passed, `baseRed` when the unchanged head's failing checks are now judged the base's red.
 */
export interface AwaitHeadOutcome {
  pr: PullRequest;
  exited: boolean;
  green?: true;
  baseRed?: true;
}

export interface AwaitHeadTiming {
  /** Whether the named agent has exited; read only while the head is unchanged. */
  agentExited?: (agent: string, signal: AbortSignal) => Promise<boolean>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The seat clones' push reflogs; absent means the PR is read once per backstop only. */
  pushes?: PushWatch;
  /** Confirms a reflog push once its repo is marked stale, and serves the checks an unchanged head is read for; absent means the port. */
  snapshot?: Pick<PrSnapshot, "invalidate" | "getPr" | "checkRuns">;
  /** Told of each transient read failure, so a wait stuck on one is visible while it runs. */
  onReadError?: (message: string) => void;
  /** Built once per wait, so the checker can keep its own memo of the base it last weighed; true means the head's red is the base's. */
  inheritedRed?: (target: AwaitHeadTarget) => (pr: PullRequest, signal: AbortSignal) => Promise<boolean>;
}

const FATAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/** `GhError` and the fake's `FakeHttpError` both carry the HTTP status; a non-Error rejection has none and is transient. */
function fatalStatus(error: unknown): number | undefined {
  const status = error instanceof Error ? errorStatus(error) : undefined;
  return typeof status === "number" && FATAL_STATUSES.has(status) ? status : undefined;
}

/**
 * Block until the PR's head differs from `target.headSha` or the PR is no longer open, and return that read. No
 * timeout, because a fix can take days. The PR is read when the clone's push reflog moves its branch, and otherwise
 * once per backstop; a transient failed read is reported and read again, a 401, 403 or 404 fails the wait because it
 * cannot heal, and `signal` aborts the wait between ticks.
 */
export async function awaitNewHead(port: GitHubPort, target: AwaitHeadTarget, signal: AbortSignal, timing: AwaitHeadTiming = {}): Promise<PullRequest> {
  return (await awaitHeadOrExit(port, target, signal, timing)).pr;
}

/** A failed read is not green; the next check reads again. */
export async function greenAtHead(port: GitHubPort, target: AwaitHeadTarget, pr: PullRequest, timing: AwaitHeadTiming): Promise<boolean> {
  const rules = await readRequiredChecks(port, target.repo, pr.baseRef);
  if (!rules.readable) return (timing.onReadError?.(rules.reason), false);
  const contexts = rules.checks.contexts;
  const reads: PrReads = timing.snapshot ?? portReads(port);
  return contexts.length > 0 && (await requiredChecksPass({ repo: target.repo, contexts }, pr.headSha, reads).catch((error: unknown) => {
    timing.onReadError?.(`${target.repo}#${target.pr} checks at ${pr.headSha}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }));
}

function headReader(port: GitHubPort, target: AwaitHeadTarget, timing: AwaitHeadTiming): () => Promise<PullRequest | undefined> {
  return () =>
    port.getPr(target.repo, target.pr).catch((error: unknown) => {
      const status = fatalStatus(error);
      const reason = error instanceof Error ? error.message : String(error);
      if (status !== undefined) throw new Error(`await-new-head cannot read ${target.repo}#${target.pr}: HTTP ${status}: ${reason}`);
      timing.onReadError?.(`${target.repo}#${target.pr}: ${reason}`);
      return undefined;
    });
}

/** The reflog confirm reads through the snapshot once its repo is dropped, so the read also refreshes what ci-wait will see. */
function confirmReader(target: AwaitHeadTarget, timing: AwaitHeadTiming, read: () => Promise<PullRequest | undefined>): (() => Promise<PullRequest | undefined>) | undefined {
  const snapshot = timing.snapshot;
  if (snapshot === undefined) return undefined;
  return () => {
    snapshot.invalidate(target.repo);
    return snapshot.getPr(target.repo, target.pr).catch(read);
  };
}

interface BaseRedWatch {
  check(pr: PullRequest, signal: AbortSignal): Promise<boolean>;
  advance(ms: number): void;
}

/** Absent unless the wait carries failing checks and a hook; a thrown check is reported and counts as not the base's. */
function baseRedWatch(target: AwaitHeadTarget, timing: AwaitHeadTiming): BaseRedWatch | undefined {
  if (!target.failing?.length || timing.inheritedRed === undefined) return undefined;
  const inherited = timing.inheritedRed(target);
  let since: number | undefined;
  return {
    async check(pr, signal) {
      if (since !== undefined && since < BASE_RED_RECHECK_MS) return false;
      since = 0;
      try {
        return await inherited(pr, signal);
      } catch (error) {
        timing.onReadError?.(`${target.repo}#${target.pr} base red at ${pr.headSha}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
    advance(ms) {
      if (since !== undefined) since += ms;
    },
  };
}

/**
 * Like `awaitNewHead`, but also ends when the fixer exits with the head unchanged, with `untilGreen` when that head
 * turns green, or with `failing` and an `inheritedRed` hook when the base turns out to own that head's red.
 */
export async function awaitHeadOrExit(port: GitHubPort, target: AwaitHeadTarget, signal: AbortSignal, timing: AwaitHeadTiming = {}): Promise<AwaitHeadOutcome> {
  const pause = timing.sleep ?? sleep;
  const read = headReader(port, target, timing);
  const poll = headPoll({ pushes: timing.pushes, repo: target.repo, headSha: target.headSha, read, confirm: confirmReader(target, timing, read), observe: headRegressionObserver(port) });
  let pr: PullRequest | undefined;
  let sinceGreen: number | undefined;
  const baseRed = baseRedWatch(target, timing);
  for (;;) {
    signal.throwIfAborted();
    const polled = await poll.next();
    if (polled.read) pr = polled.pr ?? pr;
    if (polled.read && polled.pr && (polled.pr.headSha !== target.headSha || polled.pr.state !== "open")) return { pr: polled.pr, exited: false };
    if (pr && target.untilGreen === true && (sinceGreen === undefined || sinceGreen >= CHECKS_RECHECK_MS)) {
      sinceGreen = 0;
      if (await greenAtHead(port, target, pr, timing)) return { pr, exited: false, green: true };
    }
    if (pr && baseRed && (await baseRed.check(pr, signal))) return { pr, exited: false, baseRed: true };
    if (pr && target.agent !== undefined && (await timing.agentExited?.(target.agent, signal))) {
      // Re-read after the exit is seen, so a push made just before it is not mistaken for no push.
      const last = await port.getPr(target.repo, target.pr).catch(() => undefined);
      if (last) return { pr: last, exited: last.headSha === target.headSha && last.state === "open" };
    }
    await pause(poll.tickMs, signal);
    if (sinceGreen !== undefined) sinceGreen += poll.tickMs;
    baseRed?.advance(poll.tickMs);
  }
}

export const AWAIT_HEAD_STEPS: readonly StepDeclaration[] = [{ id: "await-new-head", kind: "dispatch" }];

export const AwaitHeadResult = z.looseObject({
  headSha: z.string(),
  state: z.enum(["open", "closed"]),
  exited: z.boolean().optional(),
  green: z.boolean().optional(),
  why: z.string().optional(),
  baseRed: z.boolean().optional(),
});

export interface AwaitHeadDeps extends AwaitHeadTiming {
  port: GitHubPort;
  now?: () => number;
}

/**
 * The step reads and never writes, so a crash mid-wait repeats it; `match` lets a caller name its own step family.
 * The wait reads the port, while ci-wait reads a snapshot that may still hold the old head for a tick, and a round
 * that read the old head would send it back to the fixer again.
 */
export function awaitNewHeadRoute(deps: AwaitHeadDeps, match = "await-new-head"): StepRoute {
  return codeRoute(match, deps.now ?? Date.now, async (target: AwaitHeadTarget, signal) => {
    const { pr, exited, green, baseRed } = await awaitHeadOrExit(deps.port, target, signal, deps);
    deps.snapshot?.invalidate(target.repo);
    const why = green && { why: `every required check passed at ${target.headSha} with no new head, on a rerun or a run that outlived a cancelled one` };
    const ended = { ...(exited && { exited }), ...(green && { green }), ...why, ...(baseRed && { baseRed }) };
    return { headSha: pr.headSha, state: pr.state, merged: pr.merged, ...ended };
  });
}
