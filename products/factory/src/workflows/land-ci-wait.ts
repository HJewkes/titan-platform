import { readCi, type CiInput, type CiReadOptions, type CiSnapshot } from "./land-ci.js";
import { CI_BACKLOG_CEILING_FACTOR, MISSING_CHECK_GRACE_MS, missingCheckGraceSpent, type FirstReads } from "./land-budget.js";
import { rerunIfFlaky, type FlakyState } from "./land-flaky.js";
import { deadline, type Deadline, type DeadlineTiming } from "./deadline.js";
import type { LandDeps, Timing } from "./land.js";
import { requireRequiredChecks } from "../required-checks.js";
import { noRunVerdict, type NoRunWatch } from "../shepherd/ci-norun.js";

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

/** One blocking step: the workflow retry loop has no backoff, so polling lives here. A failed read is polled again. Both bounds run from `timing.startedAt` when given. */
export async function waitForCi(deps: LandDeps, input: CiInput, timing: Timing & Pick<DeadlineTiming, "startedAt">, signal: AbortSignal, flaky: FlakyState, firstReads: FirstReads): Promise<CiSnapshot> {
  const { port, snapshot: reads } = deps;
  const clock = deadline(timing);
  const startedAt = Math.min(timing.startedAt ?? Number.POSITIVE_INFINITY, timing.now());
  let backlog = false;
  let last = "no read yet";
  const options = readOptions(deps, input, timing, firstReads);
  const noRun: NoRunWatch = {};
  for (;;) {
    try {
      const snapshot = await readCi(port, input, reads, options);
      const readAt = timing.now();
      if (snapshot.verdict === "red" && (await rerunWithinDeadline(deps, input, snapshot, { timing, signal, flaky, clock }))) continue;
      const done = snapshot.verdict === "pending" ? await noRunVerdict(port, input, snapshot, readAt, noRun) : snapshot;
      if (done) return { ...done, readAt };
      last = `waiting on ${snapshot.waitingOn?.join(", ") || `mergeable_state ${snapshot.mergeableState}`}`;
      backlog = snapshot.backlog === true;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      backlog = false;
    }
    if (clock.expired()) {
      const ceilingMs = timing.timeoutMs * CI_BACKLOG_CEILING_FACTOR;
      if (!backlog) throw new Error(`ci-wait timed out after ${timing.timeoutMs} ms: ${last}`);
      if (timing.now() - startedAt >= ceilingMs) throw new Error(`ci-wait gave up after ${ceilingMs} ms on a CI backlog: checks still queued or running, none red; ${last}`);
    }
    await clock.sleep(timing.pollMs, signal);
  }
}
