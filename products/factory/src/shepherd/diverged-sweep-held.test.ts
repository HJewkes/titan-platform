import { fakeSha } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { REPO } from "../test-support/land.js";
import { restartDivergedRuns } from "./diverged-sweep.js";
import { answeredWhileParked, closeDeploys, ctxOf, HEAD_B, type Answered } from "../test-support/diverged-sweep.js";

afterEach(closeDeploys);

const MERGE = { decision: "merge", headSha: HEAD_B };

const mergeWaits = ({ next, runId }: Answered): Array<string | null> =>
  next.routes.shepherd!.store.get().eventsOf(runId).filter((event) => event.kind === "merge-wait").map((event) => event.reason);

/** The sweep sent no merge, restarted nothing, and left the run parked with the guard's reason on its timeline. */
function keptHeld(answered: Answered, sweep: Awaited<ReturnType<typeof restartDivergedRuns>>, reason: RegExp): void {
  const { next, runId, gateId } = answered;
  expect(sweep.merged).toEqual([]);
  expect(sweep.restarted).toEqual([]);
  expect(sweep.held).toEqual([{ runId, gateId, reason: expect.stringMatching(reason) }]);
  expect(next.fake.merges).toEqual([]);
  expect(next.host.runtime.status(runId)?.status).toBe("recovery_required");
  expect(mergeWaits(answered)).toEqual([expect.stringMatching(reason)]);
}

describe("restartDivergedRuns consults the land loop's merge guard before an owner-answer merge (TP-5802)", () => {
  it("merges nothing for a PR of a frozen repo and keeps the run parked with the freeze on its timeline", async () => {
    const answered = await answeredWhileParked(MERGE);
    answered.next.routes.shepherd!.freeze!.get().freeze(REPO, fakeSha("red-main"));

    const sweep = await restartDivergedRuns(ctxOf(answered.next));
    const again = await restartDivergedRuns(ctxOf(answered.next));

    keptHeld(answered, sweep, /frozen/);
    expect(again.held).toHaveLength(1);
    expect(mergeWaits(answered)).toHaveLength(1);
  });

  it("merges nothing for a held PR, then merges once the hold is released", async () => {
    const answered = await answeredWhileParked(MERGE);
    const store = answered.next.routes.shepherd!.store.get();
    store.hold(answered.runId, "g10-review", "rev");

    const sweep = await restartDivergedRuns(ctxOf(answered.next));
    keptHeld(answered, sweep, /g10-review/);
    store.release(answered.runId);
    const released = await restartDivergedRuns(ctxOf(answered.next));

    expect(released.merged.map((merge) => merge.runId)).toEqual([answered.runId]);
    expect(answered.next.fake.merges).toHaveLength(1);
  });

  it("merges nothing on a host that wired no merge guard", async () => {
    const answered = await answeredWhileParked(MERGE);
    delete answered.next.routes.shepherd!.heldMerge;

    keptHeld(answered, await restartDivergedRuns(ctxOf(answered.next)), /merge guard is not wired/);
  });
});
