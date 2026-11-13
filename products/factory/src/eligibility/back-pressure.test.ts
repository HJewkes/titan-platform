import { describe, expect, it } from "vitest";
import { admitLane, DEFAULT_LIMITS, filingFlow, holdsFor, type LaneSignals } from "./back-pressure.js";

const calm: LaneSignals = { openPrs: 0, mergedNotDeployed: 0, ownerQueue: 0, reviewers: { accounts: 2, exhausted: 0 }, deployStall: [], redMain: [], unread: {} };

const codes = (signals: Partial<LaneSignals>) => admitLane({ ...calm, ...signals }, DEFAULT_LIMITS).holds.map((hold) => hold.code);

describe("lane admission", () => {
  it("admits a lane with every signal calm", () => {
    expect(admitLane(calm, DEFAULT_LIMITS)).toEqual({ decision: "admit", holds: [] });
  });

  it("holds the lane at 3 unmerged PRs but not at 2", () => {
    expect(codes({ openPrs: 2 })).toEqual([]);

    const held = admitLane({ ...calm, openPrs: 3 }, DEFAULT_LIMITS);

    expect(held.decision).toBe("hold");
    expect(held.holds).toEqual([expect.objectContaining({ code: "lane-open-prs", scope: "lane", numbers: { open: 3, mergedNotDeployed: 0, limit: 3 } })]);
  });

  it("counts a merged PR that is not yet deployed as open", () => {
    expect(codes({ openPrs: 1, mergedNotDeployed: 1 })).toEqual([]);
    expect(codes({ openPrs: 2, mergedNotDeployed: 1 })).toEqual(["merged-not-deployed"]);
  });

  it("frees the slot as soon as the merged PR is deployed", () => {
    const waiting = admitLane({ ...calm, openPrs: 2, mergedNotDeployed: 1 }, DEFAULT_LIMITS);
    const landed = admitLane({ ...calm, openPrs: 2, mergedNotDeployed: 0 }, DEFAULT_LIMITS);

    expect(waiting.decision).toBe("hold");
    expect(landed.decision).toBe("admit");
  });

  it("holds only gate-creating work above 10 gates waiting on the owner, and nothing at 10", () => {
    expect(codes({ ownerQueue: 8 })).toEqual([]);
    expect(codes({ ownerQueue: 10 })).toEqual([]);

    const held = admitLane({ ...calm, ownerQueue: 11 }, DEFAULT_LIMITS);

    expect(held.decision).toBe("admit");
    expect(held.holds).toEqual([expect.objectContaining({ code: "owner-queue", scope: "gate-creating", numbers: { items: 11, limit: 10 } })]);
    expect(holdsFor(held, [{ kind: "release", note: "cut the release" }]).map((hold) => hold.code)).toEqual(["owner-queue"]);
    expect(holdsFor(held, [])).toEqual([]);
  });

  it("holds the lane only once every reviewer account is at its limit", () => {
    expect(codes({ reviewers: { accounts: 2, exhausted: 1 } })).toEqual([]);
    expect(codes({ reviewers: { accounts: 2, exhausted: 2 } })).toEqual(["reviewer-limit"]);
  });

  it("holds every lane on a deploy alarm or a red main, with the counts behind it", () => {
    expect(codes({ deployStall: ["2 refusals in a row"] })).toEqual(["dependency-stalled"]);

    const red = admitLane({ ...calm, redMain: ["octo/demo"] }, DEFAULT_LIMITS);

    expect(red.holds).toEqual([expect.objectContaining({ code: "dependency-stalled", numbers: { deployCauses: 0, redMainRepos: 1 } })]);
  });

  it("a signal nobody could read holds what it guards instead of reading as headroom", () => {
    const unread = admitLane({ unread: { deploy: "serve down", ownerQueue: "broker down" } }, DEFAULT_LIMITS);

    expect(unread.decision).toBe("hold");
    expect(unread.holds.map((hold) => [hold.code, hold.scope])).toEqual([
      ["signal-unreadable", "lane"],
      ["signal-unreadable", "gate-creating"],
    ]);
  });

  it("uses the owner's limits over the starting values", () => {
    expect(admitLane({ ...calm, openPrs: 3 }, { ...DEFAULT_LIMITS, laneOpenPrs: 4 }).decision).toBe("admit");
  });
});

describe("filing flow", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  const task = (created: string, doneAt: string | null = null) => ({ created, doneAt });

  it("pauses filing when inflow beat outflow in both of the last two complete weeks", () => {
    const tasks = [task("2026-10-27"), task("2026-10-28"), task("2026-11-03"), task("2026-11-04"), task("2026-10-01", "2026-11-05"), task("2026-11-12")];

    expect(filingFlow(tasks, now, 2)).toEqual({
      paused: true,
      weeks: [
        { week: "2026-W44", inflow: 2, outflow: 0 },
        { week: "2026-W45", inflow: 2, outflow: 1 },
      ],
    });
  });

  it("stays open when one of the weeks drained as fast as it filled", () => {
    const tasks = [task("2026-10-27"), task("2026-11-03"), task("2026-10-01", "2026-11-04")];

    expect(filingFlow(tasks, now, 2).paused).toBe(false);
  });
});
