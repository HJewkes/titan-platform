import { readCi, type CiInput, type CiSnapshot } from "./land-ci.js";
import { CI_BACKLOG_CEILING_FACTOR, MISSING_CHECK_GRACE_MS, missingCheckGraceSpent, type FirstReads } from "./land-budget.js";
import { rerunIfFlaky, type FlakyState } from "./land-flaky.js";
import { deadline } from "./deadline.js";
import type { LandDeps, Timing } from "./land.js";

/** Writes go through the port, which re-reads the PR first; the snapshot is dropped once a write is through, so the next read sees it. */
export async function afterWrite<T>(deps: LandDeps, input: { repo: string }, write: Promise<T>): Promise<T> {
  try {
    return await write;
  } finally {
    deps.snapshot?.invalidate(input.repo);
  }
}

/** One blocking step: the workflow retry loop has no backoff, so polling lives here. A failed read is polled again. */
export async function waitForCi(deps: LandDeps, input: CiInput, timing: Timing, signal: AbortSignal, flaky: FlakyState, firstReads: FirstReads): Promise<CiSnapshot> {
  const { port, snapshot: reads } = deps;
  const clock = deadline(timing);
  const startedAt = timing.now();
  let backlog = false;
  const graceMs = deps.missingCheckGraceMs ?? MISSING_CHECK_GRACE_MS;
  const missingSettled = (headSha: string) => missingCheckGraceSpent(firstReads, `${input.repo}#${input.pr}@${headSha}`, timing.now(), graceMs);
  let last = "no read yet";
  const openSeen = {};
  for (;;) {
    try {
      const snapshot = await readCi(port, input, reads, { missingSettled, openSeen });
      if (snapshot.verdict === "red" && (await afterWrite(deps, input, rerunIfFlaky(port, input, snapshot, timing, signal, flaky)))) continue;
      if (snapshot.verdict !== "pending") return { ...snapshot, readAt: timing.now() };
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
