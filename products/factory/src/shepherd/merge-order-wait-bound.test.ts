import { fakeSha } from "@titan-design/github";
import { WorkflowRunStore, type StepResult } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY, currentStep, dirtyUntilPushed, finish, hosts, loopWorld, orderEvents, REPO, results, shepherd, WAIT, X, Y, Z, type Loop } from "./merge-order-loop.test-helpers.js";
import { MERGING_STALL_LIMIT_MS } from "./view.js";

afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const STAND_IN = "run-r-stand-in";
const RESOLVED = fakeSha("y-resolved");

const ciRead = (headSha: string): StepResult => ({ stepId: "ci-wait", iteration: 0, agentId: null, signal: null, completedAt: "2026-10-23T09:59:30.000Z", data: { result: { headSha } } });

/**
 * A bare running run that reserved X's paths at Y's conflicted head and never ends that reservation on its own. Its last
 * CI read is at `ciAt`: the reserved head while its fixer works, or a resolved head while that head is in review.
 */
function longHeldReservation(loop: Loop, ciAt: "reserved" | "resolved"): void {
  const since = "2026-10-23T09:59:00.000Z";
  const reserved = loop.fake.pr(Y).headSha;
  const stepResults = { "ci-wait:r1:0": ciRead(ciAt === "reserved" ? reserved : RESOLVED) };
  new WorkflowRunStore(loop.host.db).create({ id: STAND_IN, workflowName: "stand-in", params: { repo: REPO }, status: "running", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: since, completedAt: null, error: null });
  loop.order.reserve({ repo: REPO, runId: STAND_IN, pr: Y, headSha: reserved, baseSha: loop.fake.refs.get("main")!, paths: [CAPABILITY], ahead: [], since, reason: "R stands in" });
}

async function waitingBehindHeldReservation(ciAt: "reserved" | "resolved" = "reserved"): Promise<Loop> {
  const loop = loopWorld(true);
  longHeldReservation(loop, ciAt);
  dirtyUntilPushed(loop);
  shepherd(loop, X);
  await vi.waitFor(() => expect(currentStep(loop, X)).toMatch(/^sh-order-wait/), WAIT);
  return loop;
}

/** The merge guard holds the PR's head behind the earlier reservation, so it lands once that one ends. */
async function landsOnceReleased(loop: Loop, pr: number): Promise<void> {
  loop.order.release(REPO, STAND_IN, { at: "2026-10-23T10:00:00.000Z" });
  await finish(loop, pr);
  expect(loop.merged).toEqual([pr]);
}

describe("TP-4434: a conflicted run's order wait ends at the merging stall limit", () => {
  it("wakes the fixer once the wait behind a long-held reservation passes the limit", async () => {
    const loop = await waitingBehindHeldReservation();

    loop.advance(MERGING_STALL_LIMIT_MS);
    await vi.waitFor(() => expect(loop.wakes).toHaveLength(1), WAIT);

    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [Y], moved: false, bounded: true }]);
    expect(loop.wakes.map((wake) => wake.kind)).toEqual(["conflict"]);
    expect(loop.order.list(REPO).map((reservation) => reservation.runId)).toContain(STAND_IN);
    await landsOnceReleased(loop, X);
  });

  it("keeps waiting while the wait is under the limit", async () => {
    const loop = await waitingBehindHeldReservation();

    loop.advance(MERGING_STALL_LIMIT_MS - 60_000);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(currentStep(loop, X)).toMatch(/^sh-order-wait/);
    expect(loop.wakes).toEqual([]);
    await landsOnceReleased(loop, X);
  });
});

describe("TP-4569: the merge guard after a bounded order wait", () => {
  it("lands the resolved head past a holder whose own resolved head sits in an 87 min review round (10-29, #2670)", async () => {
    const loop = await waitingBehindHeldReservation("resolved");

    loop.advance(MERGING_STALL_LIMIT_MS);
    await finish(loop, X);

    expect(loop.wakes.map((wake) => wake.kind)).toEqual(["conflict"]);
    expect(loop.merged).toEqual([X]);
    expect(loop.order.list(REPO).map((reservation) => reservation.runId)).toEqual([STAND_IN]);
  });

  it("still holds a PR that never waited out its turn behind the holder in review", async () => {
    const loop = loopWorld(true);
    longHeldReservation(loop, "resolved");

    const z = shepherd(loop, Z);
    await vi.waitFor(() => expect(orderEvents(loop, z)).toContain("order-wait"), WAIT);

    expect(loop.merged).toEqual([]);
    await landsOnceReleased(loop, Z);
  });
});
