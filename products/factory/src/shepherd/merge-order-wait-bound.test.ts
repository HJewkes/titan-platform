import { WorkflowRunStore } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY, currentStep, dirtyUntilPushed, finish, hosts, loopWorld, REPO, results, shepherd, WAIT, X, Y, type Loop } from "./merge-order-loop.test-helpers.js";
import { MERGING_STALL_LIMIT_MS } from "./view.js";

afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const STAND_IN = "run-r-stand-in";

/** A bare running run whose resolved head sits in a long review round, so its reservation over X's paths never ends on its own. */
function longHeldReservation(loop: Loop): void {
  const since = "2026-10-23T09:59:00.000Z";
  new WorkflowRunStore(loop.host.db).create({ id: STAND_IN, workflowName: "stand-in", params: { repo: REPO }, status: "running", currentStep: null, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: since, completedAt: null, error: null });
  loop.order.reserve({ repo: REPO, runId: STAND_IN, pr: Y, headSha: loop.fake.pr(Y).headSha, baseSha: loop.fake.refs.get("main")!, paths: [CAPABILITY], ahead: [], since, reason: "R stands in" });
}

async function waitingBehindHeldReservation(): Promise<Loop> {
  const loop = loopWorld(true);
  longHeldReservation(loop);
  dirtyUntilPushed(loop);
  shepherd(loop, X);
  await vi.waitFor(() => expect(currentStep(loop, X)).toMatch(/^sh-order-wait/), WAIT);
  return loop;
}

/** The merge guard still holds X's resolved head behind the earlier reservation, so X lands once that one ends. */
async function landsOnceReleased(loop: Loop): Promise<void> {
  loop.order.release(REPO, STAND_IN, { at: "2026-10-23T10:00:00.000Z" });
  await finish(loop, X);
  expect(loop.merged).toEqual([X]);
}

describe("TP-4434: a conflicted run's order wait ends at the merging stall limit", () => {
  it("wakes the fixer once the wait behind a long-held reservation passes the limit", async () => {
    const loop = await waitingBehindHeldReservation();

    loop.advance(MERGING_STALL_LIMIT_MS);
    await vi.waitFor(() => expect(loop.wakes).toHaveLength(1), WAIT);

    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [Y], moved: false }]);
    expect(loop.wakes.map((wake) => wake.kind)).toEqual(["conflict"]);
    expect(loop.order.list(REPO).map((reservation) => reservation.runId)).toContain(STAND_IN);
    await landsOnceReleased(loop);
  });

  it("keeps waiting while the wait is under the limit", async () => {
    const loop = await waitingBehindHeldReservation();

    loop.advance(MERGING_STALL_LIMIT_MS - 60_000);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(currentStep(loop, X)).toMatch(/^sh-order-wait/);
    expect(loop.wakes).toEqual([]);
    await landsOnceReleased(loop);
  });
});
