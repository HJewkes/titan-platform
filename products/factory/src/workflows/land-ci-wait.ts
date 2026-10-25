import { headRegressionObserver } from "../head-guard/head-regression.js";
import { SECOND_READ, readCi, type CiInput, type CiReadOptions, type CiSnapshot } from "./land-ci.js";
import { CI_BACKLOG_CEILING_FACTOR, MISSING_CHECK_GRACE_MS, missingCheckGraceSpent, type FirstReads } from "./land-budget.js";
import { rerunIfFlaky, type FlakyState } from "./land-flaky.js";
import { deadline, type Deadline, type DeadlineTiming } from "./deadline.js";
import type { LandDeps, Timing } from "./land.js";
import { requireRequiredChecks } from "../required-checks.js";
import { noRunVerdict, type NoRunWatch } from "../shepherd/ci-norun.js";
import { orphanVerdict, orphanWatch } from "./land-orphan.js";
import { clearCiWaitHead, noteCiWaitHead } from "./ci-wait-head.js";

/** Writes go through the port, which re-reads the PR first; the snapshot is dropped once a write is through, so the next read sees it. */
export async function afterWrite<T>(deps: LandDeps, input: { repo: string }, write: Promise<T>): Promise<T> {
  try {
    return await write;
  } finally {
    deps.snapshot?.invalidate(input.repo);
  }
}

/** A rerun and its wait can outlast the step's deadline; `continue` skips the expiry check, so it is made here. */
async function rerunWithinDeadline(deps: LandDeps, input: CiInput, red: CiSnapshot, run: { timing: Timing; signal: AbortSignal; flaky: FlakyState; clock: Deadline }): Promise<boolean> {
  const rerun = await afterWrite(deps, input, rerunIfFlaky(deps.port, input, red, run.timing, run.signal, run.flaky));
  if (rerun && run.clock.expired()) throw new Error(`ci-wait timed out after ${run.timing.timeoutMs} ms: rerunning a flaky check`);
  return rerun;
}

/** One ci-wait's read options: its open-repo run sets and the grace a never-reported required check gets live across its polls. */
function readOptions(deps: LandDeps, input: CiInput, timing: Timing, firstReads: FirstReads): CiReadOptions {
  const graceMs = deps.missingCheckGraceMs ?? MISSING_CHECK_GRACE_MS;
  const missingSettled = (headSha: string) => missingCheckGraceSpent(firstReads, `${input.repo}#${input.pr}@${headSha}`, timing.now(), graceMs);
  const liveContexts = async (baseRef: string) => (await requireRequiredChecks(deps.port, input.repo, baseRef)).contexts;
  return { missingSettled, openSeen: {}, liveContexts };
}

/** Each read tells the head-regression log which head the previous read saw; the answer is the read's own. */
function observedReadCi(port: LandDeps["port"], reads: LandDeps["snapshot"], options: CiReadOptions): (input: CiInput) => Promise<CiSnapshot> {
  const observeHead = headRegressionObserver(port);
  let heldHead: string | undefined;
  return async (input) => {
    const snapshot = await readCi(port, input, reads, { ...options, heldHead, observeHead });
    heldHead = snapshot.headSha;
    noteCiWaitHead(input.repo, input.pr, snapshot.headSha);
    return snapshot;
  };
}

/** One blocking step: the workflow retry loop has no backoff, so polling lives here. A failed read is polled again. Both bounds run from `timing.startedAt` when given. */
export async function waitForCi(deps: LandDeps, input: CiInput, timing: Timing & Pick<DeadlineTiming, "startedAt">, signal: AbortSignal, flaky: FlakyState, firstReads: FirstReads): Promise<CiSnapshot> {
  try {
    return await pollCi(deps, input, timing, signal, flaky, firstReads);
  } finally {
    clearCiWaitHead(input.repo, input.pr);
  }
}

/** What the polls so far leave for the expiry check. */
interface PollState {
  last: string;
  backlog: boolean;
  /** The newest poll waited on something only GitHub ends; see `CI_WAIT_ATTEMPTS`. */
  unsettled: boolean;
  /** The newest read that answered, which a timed-out window returns so land can wait again. */
  answered?: CiSnapshot;
}

async function pollCi(deps: LandDeps, input: CiInput, timing: Timing & Pick<DeadlineTiming, "startedAt">, signal: AbortSignal, flaky: FlakyState, firstReads: FirstReads): Promise<CiSnapshot> {
  const { port, snapshot: reads } = deps;
  const clock = deadline(timing);
  const startedAt = Math.min(timing.startedAt ?? Number.POSITIVE_INFINITY, timing.now());
  const poll: PollState = { last: "no read yet", backlog: false, unsettled: false };
  const read = observedReadCi(port, reads, readOptions(deps, input, timing, firstReads));
  const noRun: NoRunWatch = {};
  const orphans = orphanWatch();
  for (;;) {
    try {
      const snapshot = await read(input);
      const readAt = timing.now();
      if (snapshot.verdict === "red" && (await rerunWithinDeadline(deps, input, snapshot, { timing, signal, flaky, clock }))) continue;
      const done = snapshot.verdict === "pending" ? ((await noRunVerdict(port, input, snapshot, readAt, noRun)) ?? (await orphanVerdict(port, input, snapshot, readAt, orphans))) : snapshot;
      if (done) return { ...done, readAt };
      observePending(poll, snapshot);
    } catch (error) {
      observeFailure(poll, error);
    }
    const timedOut = clock.expired() ? atExpiry(timing, startedAt, poll) : undefined;
    if (timedOut) return timedOut;
    await clock.sleep(timing.pollMs, signal);
  }
}

function observePending(poll: PollState, snapshot: CiSnapshot): void {
  const waitingOn = snapshot.waitingOn ?? [];
  poll.last = `waiting on ${waitingOn.join(", ") || `mergeable_state ${snapshot.mergeableState}`}`;
  poll.backlog = snapshot.backlog === true;
  poll.unsettled = waitingOn.length === 0 ? snapshot.mergeableState === "unknown" : waitingOn.every((name) => name === SECOND_READ);
  poll.answered = snapshot;
}

function observeFailure(poll: PollState, error: unknown): void {
  poll.last = error instanceof Error ? error.message : String(error);
  poll.backlog = false;
  poll.unsettled = isServerError(error);
}

/** GitHub's own side failed the read: a 5xx status, or one the gh CLI only names in its message. */
function isServerError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status >= 500;
  return error instanceof Error && /\bHTTP 5\d\d\b/.test(error.message);
}

/** Undefined keeps polling. A wait no read has answered yet has no head to return, so it fails as any other timeout. */
function atExpiry(timing: Timing, startedAt: number, poll: PollState): CiSnapshot | undefined {
  if (poll.unsettled && poll.answered) return { ...poll.answered, readAt: timing.now(), timedOut: { afterMs: timing.timeoutMs, reason: poll.last } };
  const ceilingMs = timing.timeoutMs * CI_BACKLOG_CEILING_FACTOR;
  if (!poll.backlog) throw new Error(`ci-wait timed out after ${timing.timeoutMs} ms: ${poll.last}`);
  if (timing.now() - startedAt >= ceilingMs) throw new Error(`ci-wait gave up after ${ceilingMs} ms on a CI backlog: checks still queued or running, none red; ${poll.last}`);
  return undefined;
}
