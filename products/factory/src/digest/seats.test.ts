import { describe, expect, it } from "vitest";
import { NOW, watchRow } from "../test-support/digest.js";
import type { AgentSpan } from "./flow.js";
import { seatLines } from "./seats.js";

const SINCE = new Date(NOW.getTime() - 6 * 3_600_000);
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const agent = (name: string, spawnedBy: string | undefined, startedHoursAgo: number): AgentSpan => ({
  name,
  profile: "implementer",
  startedAt: hoursAgo(startedHoursAgo),
  live: false,
  ...(spawnedBy !== undefined && { spawnedBy }),
});
const mergedBy = (pr: number, implementer: string | null) =>
  watchRow({ pr, runId: `run-${pr}`, implementer, phase: "done", phaseSince: hoursAgo(1), outcome: { kind: "merged", reason: null } });

describe("seat lines", () => {
  it("credits each merge and spawn to the coordinator at the top of the spawned-by chain", () => {
    const roster = [
      agent("lead-coord", "human", 40),
      agent("worker-1", "lead-coord", 2),
      agent("reviewer-1", "worker-1", 1),
      agent("other-coord", undefined, 40),
      agent("worker-2", "other-coord", 10),
    ];

    const lines = seatLines([mergedBy(1, "worker-1"), mergedBy(2, "worker-2"), mergedBy(3, null)], roster, SINCE);

    expect(lines).toEqual([
      { seat: "lead-coord", merges: 1, spawns: 2 },
      { seat: "other-coord", merges: 1, spawns: 0 },
      { seat: "unattributed", merges: 1, spawns: 0 },
    ]);
  });

  it("stops at a spawned-by loop instead of walking it forever", () => {
    const roster = [agent("loop-a", "loop-b", 1), agent("loop-b", "loop-a", 1)];

    expect(seatLines([mergedBy(1, "loop-a")], roster, SINCE)).toEqual([
      { seat: "loop-b", merges: 1, spawns: 1 },
      { seat: "loop-a", merges: 0, spawns: 1 },
    ]);
  });
});
