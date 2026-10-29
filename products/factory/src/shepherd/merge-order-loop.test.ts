import { WorkflowRunStore } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTO_POLICY, CAPABILITY, currentStep, dirtyUntilPushed, finish, hosts, loopWorld, orderEvents, orderReasonForZ, REPO, results, shepherd, WAIT, X, Y, Z, type Loop } from "./merge-order-loop.test-helpers.js";
import { fakeSha, successRun } from "@titan-design/github";

afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A run the owner holds in its merge step, which reads as merging to every other run. */
function heldInMerge(loop: Loop, pr: number): string {
  const runId = shepherd(loop, pr);
  loop.store.hold(runId, "owner hold in this test");
  return runId;
}

/**
 * R stands in for an unheld conflicted run that reserved Y's paths while `ahead` was merging, so it waits on `ahead` and
 * holds the rest. It is a bare running run that never merges Y; a held one would order nothing (TP-4133).
 */
function reserveAhead(loop: Loop, ahead: string): string {
  const since = "2026-10-23T09:59:00.000Z";
  const r = "run-r-stand-in";
  new WorkflowRunStore(loop.host.db).create({ id: r, workflowName: "stand-in", params: { repo: REPO }, status: "running", currentStep: null, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: since, completedAt: null, error: null });
  loop.order.reserve({ repo: REPO, runId: r, pr: Y, headSha: loop.fake.pr(Y).headSha, baseSha: loop.fake.refs.get("main")!, paths: [CAPABILITY], ahead: [ahead], since, reason: "R waits on X" });
  return r;
}

const endReservation = (loop: Loop, r: string): void => void loop.order.release(REPO, r, { at: "2026-10-23T10:00:00.000Z" });

/** Y lands first, so X starts out conflicted; Z's review waits until X's conflict is under way. */
async function afterY(loop: Loop): Promise<void> {
  shepherd(loop, Y);
  await vi.waitFor(() => expect(loop.merged).toEqual([Y]), WAIT);
}

describe("TP-4098 slice C: the #2301 loop", () => {
  it("with merge order off, a later overlapping merge re-conflicts the resolved PR", async () => {
    const loop = loopWorld(false);
    loop.beforeZReview = () => vi.waitFor(() => expect(loop.wakes.length).toBeGreaterThan(0), WAIT);
    loop.duringWake = () => vi.waitFor(() => expect(loop.merged).toContain(Z), WAIT);
    await afterY(loop);

    shepherd(loop, X);
    shepherd(loop, Z);
    await finish(loop, X, Z);

    expect(loop.merged).toEqual([Y, Z, X]);
    expect(loop.wakes).toHaveLength(2);
  });

  it("with merge order on, the conflicted PR is resolved once and lands before the next overlapping PR", async () => {
    const loop = loopWorld(true);
    const reasons: (string | undefined)[] = [];
    loop.beforeZReview = () => vi.waitFor(() => expect(loop.wakes.length).toBeGreaterThan(0), WAIT);
    loop.duringWake = async () => {
      await vi.waitFor(() => expect(currentStep(loop, Z)).toMatch(/^merge:/), WAIT);
      reasons.push(await orderReasonForZ(loop));
    };
    await afterY(loop);

    shepherd(loop, X);
    shepherd(loop, Z);
    await finish(loop, X, Z);

    expect(loop.merged).toEqual([Y, X, Z]);
    expect(loop.wakes).toHaveLength(1);
    expect(reasons).toEqual([`merge order: waiting behind #${X} (${CAPABILITY})`]);
    expect(results(loop, Z, "merge:")).toContainEqual(expect.objectContaining({ done: false, skipped: "held" }));
    expect([...results(loop, X, "sh-seat-notice"), ...results(loop, Z, "sh-seat-notice")]).toEqual([]);
  });

  it("lets a PR already in its merge step land first, then wakes the conflicted PR once at the base it leaves", async () => {
    const loop = loopWorld(true);
    await afterY(loop);
    const z = shepherd(loop, Z);
    loop.store.hold(z, "owner hold in this test");
    await vi.waitFor(() => expect(currentStep(loop, Z)).toMatch(/^merge:/), WAIT);

    shepherd(loop, X);
    await vi.waitFor(() => expect(loop.wakes.length > 0 || /^sh-order-wait/.test(currentStep(loop, X) ?? "")).toBe(true), WAIT);
    loop.store.release(z);
    await finish(loop, X, Z);

    expect(loop.merged).toEqual([Y, Z, X]);
    expect(loop.wakes).toHaveLength(1);
    expect(loop.wakes[0]!.mergedBefore).toEqual([Y, Z]);
    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [Z], moved: false }]);
  });

  it("skips the wake when the head moves during the order wait, and lands the next round", async () => {
    const loop = loopWorld(true);
    await afterY(loop);
    const z = shepherd(loop, Z);
    loop.store.hold(z, "owner hold in this test");
    await vi.waitFor(() => expect(currentStep(loop, Z)).toMatch(/^merge:/), WAIT);

    shepherd(loop, X);
    await vi.waitFor(() => expect(currentStep(loop, X)).toMatch(/^sh-order-wait/), WAIT);
    const pushed = fakeSha("loop-pushed");
    loop.fake.commits.set(pushed, { sha: pushed, parents: [loop.fake.pr(X).headSha, loop.fake.refs.get("main")!] });
    loop.fake.pushHead(X, pushed);
    loop.fake.onGetPr = ((greenRuns) => (pr, reads) => (greenRuns(pr, reads), pr.number === X && (pr.mergeableState = "clean")))(loop.fake.onGetPr!);
    await finish(loop, X);

    expect(loop.wakes).toEqual([]);
    expect(loop.merged).toEqual([Y, X]);
    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [Z], moved: true }]);
  });

  it("never counts a run held behind a live reservation as merging ahead, so three runs never wait in a ring", async () => {
    const loop = loopWorld(true);
    const x = heldInMerge(loop, X);
    await vi.waitFor(() => expect(currentStep(loop, X)).toMatch(/^merge:/), WAIT);
    const r = reserveAhead(loop, x);
    shepherd(loop, Z);
    await vi.waitFor(() => expect(currentStep(loop, Z)).toMatch(/^merge:/), WAIT);

    dirtyUntilPushed(loop);
    loop.store.release(x);
    await finish(loop, X);
    endReservation(loop, r);
    await finish(loop, Z);

    expect(results(loop, X, "sh-order-reserve")).toEqual([{ reserved: true, ahead: [] }]);
    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [], moved: false }]);
    expect(loop.wakes).toHaveLength(1);
    expect(loop.merged).toEqual([X, Z]);
  });

  it("stops waiting on a run it let merge first once that run is held behind a live reservation", async () => {
    const loop = loopWorld(true);
    const z = heldInMerge(loop, Z);
    await vi.waitFor(() => expect(currentStep(loop, Z)).toMatch(/^merge:/), WAIT);
    dirtyUntilPushed(loop);
    const x = shepherd(loop, X);
    await vi.waitFor(() => expect(currentStep(loop, X)).toMatch(/^sh-order-wait/), WAIT);

    const r = reserveAhead(loop, x);
    await finish(loop, X);
    endReservation(loop, r);
    loop.store.release(z);
    await finish(loop, Z);

    expect(results(loop, X, "sh-order-reserve")).toEqual([{ reserved: true, ahead: [z] }]);
    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [Z], moved: false }]);
    expect(loop.wakes).toHaveLength(1);
    expect(loop.merged).toEqual([X, Z]);
  });

  it("never waits behind an earlier overlapping reservation whose run a person holds (TP-4133)", async () => {
    const loop = loopWorld(true);
    const r = reserveAhead(loop, "run-none");
    loop.store.register({ repo: REPO, pr: Y, runId: r, task: `demo/${Y}`, implementer: `impl-${Y}`, policy: AUTO_POLICY });
    loop.store.hold(r, "g10-adversary: policy touch");
    dirtyUntilPushed(loop);

    shepherd(loop, X);
    await finish(loop, X);

    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [], moved: false }]);
    expect(loop.merged).toEqual([X]);
  });

  it("stops waiting on a run it let merge first once that run leaves its merge step unmerged", async () => {
    const loop = loopWorld(true);
    const zAtWake: (string | undefined)[] = [];
    await afterY(loop);
    const z = heldInMerge(loop, Z);
    loop.duringWake = async () => void zAtWake.push(loop.host.runtime.status(z)?.status);
    await vi.waitFor(() => expect(currentStep(loop, Z)).toMatch(/^merge:/), WAIT);
    shepherd(loop, X);
    await vi.waitFor(() => expect(currentStep(loop, X)).toMatch(/^sh-order-wait/), WAIT);

    const red = fakeSha("loop-z-red");
    loop.fake.onGetPr = ((greenRuns) => (pr, reads) => (greenRuns(pr, reads), pr.headSha === red && loop.fake.setRuns(red, [successRun("validate", 3, undefined, "failure")])))(loop.fake.onGetPr!);
    loop.fake.pushHead(Z, red);
    await finish(loop, X);
    loop.host.runtime.cancel(z, "ended in this test");

    expect(zAtWake).toEqual(["running"]);
    expect(results(loop, X, "sh-order-reserve")).toEqual([{ reserved: true, ahead: [z] }]);
    expect(results(loop, X, "sh-order-wait")).toEqual([{ waitedBehind: [Z], moved: false }]);
    expect(loop.merged).toEqual([Y, X]);
  });

  it("releases the reservation when its run lands", async () => {
    const loop = loopWorld(true);
    const during: string[][] = [];
    loop.duringWake = async () => void during.push(loop.order.list(REPO).map((reservation) => reservation.runId));
    await afterY(loop);

    const x = shepherd(loop, X);
    await finish(loop, X);

    expect(during).toEqual([[x]]);
    expect(loop.merged).toEqual([Y, X]);
    expect(loop.order.list(REPO)).toEqual([]);
    expect(orderEvents(loop, x)).toEqual(["order-reserve", "order-release"]);
  });

  it("logs the expiry once and tells the seat once when the reservation outlives its TTL", async () => {
    const loop = loopWorld(true, 60);
    loop.duringWake = async () => loop.advance(2 * 60 * 60_000);
    await afterY(loop);

    const x = shepherd(loop, X);
    await finish(loop, X);

    expect(loop.merged).toEqual([Y, X]);
    expect(results(loop, X, "sh-order-expire")).toEqual([{ expired: true, ttlMinutes: 60 }]);
    expect(orderEvents(loop, x)).toEqual(["order-reserve", "order-expired"]);
    expect(loop.told).toEqual([expect.stringMatching(/^demo-seat: Shepherd: hjewkes\/titan-platform#2301 .*merge order: its reservation passed the 60 min TTL/)]);
  });
});
