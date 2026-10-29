import { fakeSha } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY, currentStep, dirtyUntilPushed, finish, hosts, loopWorld, orderEvents, orderReasonForZ, REPO, shepherd, WAIT, X, Y, Z } from "./merge-order-loop.test-helpers.js";

afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** The resolved head of X's first conflict wake, and the head its review fix pushes after it. */
const RESOLVED = fakeSha("loop-fix-1");
const REVIEW_FIXED = fakeSha("loop-fix-2");

describe("TP-4497: a reservation is held only through a conflict round or at a landable head", () => {
  it("a review fix round releases the reservation and a ready overlapping PR lands", async () => {
    const loop = loopWorld(true);
    const during: string[][] = [];
    loop.fixFirstAt.add(RESOLVED);
    loop.duringWake = async () => {
      if (loop.wakes.at(-1)?.kind !== "review") return;
      during.push(loop.order.list(REPO).map((reservation) => reservation.runId));
      shepherd(loop, Z);
      await vi.waitFor(() => expect(loop.merged).toContain(Z), WAIT);
    };
    dirtyUntilPushed(loop);

    const x = shepherd(loop, X);
    await finish(loop, X);
    await finish(loop, Z);

    expect(during).toEqual([[]]);
    expect(loop.merged).toEqual([Z, X]);
    expect(loop.wakes.map((wake) => wake.kind)).toEqual(["conflict", "review", "conflict"]);
    expect(orderEvents(loop, x)).toEqual(["order-reserve", "order-release", "order-reserve", "order-release"]);
  });

  it("a run back at a landable head after a review fix takes its reservation again and the order is respected", async () => {
    const loop = loopWorld(true);
    const held: string[] = [];
    const reasons: (string | undefined)[] = [];
    loop.fixFirstAt.add(RESOLVED);
    loop.beforeMerge = async (pr) => {
      if (pr !== X) return;
      held.push(...loop.order.list(REPO).map((reservation) => reservation.reason));
      shepherd(loop, Z);
      reasons.push(await orderReasonForZ(loop));
    };
    dirtyUntilPushed(loop);

    const x = shepherd(loop, X);
    await finish(loop, X);
    await finish(loop, Z);

    expect(held).toEqual([`landable again at ${REVIEW_FIXED}`]);
    expect(reasons).toEqual([`merge order: waiting behind #${X} (${CAPABILITY})`]);
    expect(loop.merged).toEqual([X, Z]);
    expect(orderEvents(loop, x)).toEqual(["order-reserve", "order-release", "order-reserve", "order-release"]);
  });

  it("a conflict that ends the land round during review keeps the reservation through the resolved head's round", async () => {
    const loop = loopWorld(true);
    const reasons: (string | undefined)[] = [];
    const first = loop.fake.pr(X).headSha;
    loop.beforeXReview = async (headSha) => {
      if (headSha === first) {
        shepherd(loop, Y);
        await vi.waitFor(() => expect(loop.merged).toEqual([Y]), WAIT);
      }
      if (headSha !== RESOLVED) return;
      shepherd(loop, Z);
      await vi.waitFor(() => expect(loop.merged.includes(Z) || /^merge:/.test(currentStep(loop, Z) ?? "")).toBe(true), WAIT);
      reasons.push(await orderReasonForZ(loop));
    };

    const x = shepherd(loop, X);
    await finish(loop, X);
    await finish(loop, Z);

    expect(reasons).toEqual([`merge order: waiting behind #${X} (${CAPABILITY})`]);
    expect(loop.merged).toEqual([Y, X, Z]);
    expect(loop.wakes.map((wake) => wake.kind)).toEqual(["conflict"]);
    expect(orderEvents(loop, x)).toEqual(["order-reserve", "order-release"]);
  });
});
