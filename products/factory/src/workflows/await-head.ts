import type { GitHubPort, PullRequest, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import type { StepRoute } from "@titan-design/workflow";
import { readRequiredChecks } from "../required-checks.js";
import { codeRoute, sleep } from "./land.js";
import { requiredChecksPass } from "./land-ci.js";
import { portReads, type PrSnapshot } from "./pr-snapshot.js";

export const AWAIT_HEAD_POLL_MS = 30_000;

/** The pull request and the head a human saw fail; the wait ends once the PR shows any other head. */
export interface AwaitHeadTarget {
  repo: RepoSlug;
  pr: number;
  headSha: string;
  /** The woken fixer; once it has exited with the head unchanged, the wait ends instead of running on. */
  agent?: string;
  /** Set after a red ci-wait: every required check passing at the unchanged head, as after a rerun of the failed jobs, also ends the wait. */
  untilGreen?: boolean;
}

/** How the wait ended: `exited` when the fixer ended with the head unchanged and the PR open, `green` when the unchanged head's required checks all passed. */
export interface AwaitHeadOutcome {
  pr: PullRequest;
  exited: boolean;
  green?: true;
}

export interface AwaitHeadTiming {
  /** Whether the named agent has exited; read only while the head is unchanged. */
  agentExited?: (agent: string, signal: AbortSignal) => Promise<boolean>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  /** Told of each transient read failure, so a wait stuck on one is visible while it runs. */
  onReadError?: (message: string) => void;
}

const FATAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

/** `GhError` and the fake's `FakeHttpError` both carry the HTTP status; a non-Error rejection has none and is transient. */
function fatalStatus(error: unknown): number | undefined {
  const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" && FATAL_STATUSES.has(status) ? status : undefined;
}

/**
 * Block until the PR's head differs from `target.headSha` or the PR is no longer open, and return that read. No
 * timeout, because a fix can take days; a transient failed read is reported and polled again, a 401, 403 or 404 fails the wait because it
 * cannot heal, and `signal` aborts the wait between polls.
 */
export async function awaitNewHead(port: GitHubPort, target: AwaitHeadTarget, signal: AbortSignal, timing: AwaitHeadTiming = {}): Promise<PullRequest> {
  return (await awaitHeadOrExit(port, target, signal, timing)).pr;
}

/** A failed read is not green; the next poll reads again. */
async function greenAtHead(port: GitHubPort, target: AwaitHeadTarget, pr: PullRequest, timing: AwaitHeadTiming): Promise<boolean> {
  const rules = await readRequiredChecks(port, target.repo, pr.baseRef);
  if (!rules.readable) return (timing.onReadError?.(rules.reason), false);
  const contexts = rules.checks.contexts;
  return contexts.length > 0 && (await requiredChecksPass({ repo: target.repo, contexts }, pr.headSha, portReads(port)).catch((error: unknown) => {
    timing.onReadError?.(`${target.repo}#${target.pr} checks at ${pr.headSha}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }));
}

/** Like `awaitNewHead`, but also ends when the fixer exits with the head unchanged, or, with `untilGreen`, when that head turns green. */
export async function awaitHeadOrExit(port: GitHubPort, target: AwaitHeadTarget, signal: AbortSignal, timing: AwaitHeadTiming = {}): Promise<AwaitHeadOutcome> {
  const pause = timing.sleep ?? sleep;
  for (;;) {
    signal.throwIfAborted();
    const pr = await port.getPr(target.repo, target.pr).catch((error: unknown) => {
      const status = fatalStatus(error);
      const reason = error instanceof Error ? error.message : String(error);
      if (status !== undefined) throw new Error(`await-new-head cannot read ${target.repo}#${target.pr}: HTTP ${status}: ${reason}`);
      timing.onReadError?.(`${target.repo}#${target.pr}: ${reason}`);
      return undefined;
    });
    if (pr && (pr.headSha !== target.headSha || pr.state !== "open")) return { pr, exited: false };
    if (pr && target.untilGreen === true && (await greenAtHead(port, target, pr, timing))) return { pr, exited: false, green: true };
    if (pr && target.agent !== undefined && (await timing.agentExited?.(target.agent, signal))) {
      // Re-read after the exit is seen, so a push made just before it is not mistaken for no push.
      const last = await port.getPr(target.repo, target.pr).catch(() => undefined);
      if (last) return { pr: last, exited: last.headSha === target.headSha && last.state === "open" };
    }
    await pause(timing.pollMs ?? AWAIT_HEAD_POLL_MS, signal);
  }
}

export const AWAIT_HEAD_STEPS: readonly StepDeclaration[] = [{ id: "await-new-head", kind: "dispatch" }];

export const AwaitHeadResult = z.looseObject({ headSha: z.string(), state: z.enum(["open", "closed"]), exited: z.boolean().optional(), green: z.boolean().optional() });

export interface AwaitHeadDeps extends AwaitHeadTiming {
  port: GitHubPort;
  now?: () => number;
  /** Dropped for the repo once the wait sees the new head, so the next ci-wait and sh-observe read that head too. */
  snapshot?: Pick<PrSnapshot, "invalidate">;
}

/**
 * The step reads and never writes, so a crash mid-wait repeats it; `match` lets a caller name its own step family.
 * The wait reads the port, while ci-wait reads a snapshot that may still hold the old head for a tick, and a round
 * that read the old head would send it back to the fixer again.
 */
export function awaitNewHeadRoute(deps: AwaitHeadDeps, match = "await-new-head"): StepRoute {
  return codeRoute(match, deps.now ?? Date.now, async (target: AwaitHeadTarget, signal) => {
    const { pr, exited, green } = await awaitHeadOrExit(deps.port, target, signal, deps);
    deps.snapshot?.invalidate(target.repo);
    return { headSha: pr.headSha, state: pr.state, merged: pr.merged, ...(exited && { exited }), ...(green && { green }) };
  });
}
