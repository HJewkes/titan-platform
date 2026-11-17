import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { gateStripReader } from "./gate-strip.js";
import type { ShepherdSource } from "./shepherd.js";

const HEAD = "1234567890abcdef1234567890abcdef12345678";
type Row = Awaited<ReturnType<ShepherdSource["list"]>>[number];

const row = (index: number, pinned = true): Row => ({
  repo: "example/repo",
  pr: pinned ? 100 + index : null,
  branch: "feat/x",
  runId: `run-${index}`,
  task: "example/EX-1",
  phase: "approve",
  headSha: pinned ? HEAD : null,
  phaseSince: "2026-10-10T00:00:00.000Z",
  nextAction: "approve-merge",
  pendingGate: { gateId: `run-${index}/approve-merge`, stepId: "approve-merge", since: "2026-10-10T00:00:00.000Z" },
  held: null,
  stalled: null,
});

/** Records each upstream call and how many were in flight at once; every call takes a tick. */
function trackedShepherd() {
  const calls: string[] = [];
  let inFlight = 0;
  const peak = { value: 0 };
  async function tracked<T>(name: string, answer: T): Promise<T> {
    calls.push(name);
    inFlight++;
    peak.value = Math.max(peak.value, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    return answer;
  }
  const shepherd = partialFake<ShepherdSource>({
    timeline: (repo: string, pr: number) => tracked("timeline", { row: row(0), entries: [] as unknown[], repo, pr }),
    waiting: () => tracked("waiting", { owner: [], seat: [] }),
    checkRuns: () => tracked("checkRuns", { total_count: 0, check_runs: [] }),
  });
  return { shepherd, calls, peak };
}

describe("gateStripReader.warm", () => {
  it("fills the kept reads, so the first readMany after it makes no upstream call", async () => {
    const { shepherd, calls } = trackedShepherd();
    const reader = gateStripReader(shepherd, () => 0);

    await reader.warm([row(0)], 6);
    const afterWarm = [...calls];
    await reader.readMany([row(0)]);

    expect([...afterWarm].sort()).toEqual(["checkRuns", "timeline", "waiting"]);
    expect(calls).toEqual(afterWarm);
  });

  it("reads the waiting gates even when no run is pinned to a head", async () => {
    const { shepherd, calls } = trackedShepherd();
    const reader = gateStripReader(shepherd, () => 0);

    await reader.warm([row(0, false)], 6);

    expect(calls).toEqual(["waiting"]);
  });

  it("keeps at most six upstream reads in flight across many PRs", async () => {
    const { shepherd, peak } = trackedShepherd();
    const reader = gateStripReader(shepherd, () => 0);

    await reader.warm(Array.from({ length: 12 }, (_, index) => row(index)), 6);

    expect(peak.value).toBeGreaterThan(1);
    expect(peak.value).toBeLessThanOrEqual(6);
  });
});
