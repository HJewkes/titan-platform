import { describe, expect, it } from "vitest";
import { fakeSources, NOW, SLOT, watchRow } from "../test-support/digest.js";
import { collectDigest } from "./collect.js";
import type { AgentSpan } from "./flow.js";
import { rankDigest } from "./rank.js";
import { renderMarkdown } from "./render-md.js";

const WINDOW_MINUTES = 360;
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const merged = (n: number, task: string, mergedHoursAgo: number) =>
  watchRow({ pr: n, runId: `run-${n}`, task, phase: "done", phaseSince: hoursAgo(mergedHoursAgo), outcome: { kind: "merged", reason: null } });
const span = (profile: string, startedHoursAgo: number, endedHoursAgo?: number): AgentSpan => ({
  profile,
  startedAt: hoursAgo(startedHoursAgo),
  live: endedHoursAgo === undefined,
  ...(endedHoursAgo !== undefined && { endedAt: hoursAgo(endedHoursAgo) }),
});

async function collect(rows: ReturnType<typeof merged>[], created: Record<string, string>, spans: AgentSpan[]) {
  return collectDigest({
    sources: fakeSources({
      rows: async () => rows,
      flow: { taskCreated: async (task) => created[task], roster: async () => spans },
    }),
    now: NOW,
    windowMinutes: WINDOW_MINUTES,
    slot: SLOT,
  });
}

describe("flow numbers in the digest", () => {
  it("takes the median hours from a task's created date to its run's merge", async () => {
    // NOW is 2026-03-10T19:30Z; created dates read as midnight UTC.
    const rows = [merged(1, "demo/T-1", 1), merged(2, "demo/T-2", 2), merged(3, "demo/T-3", 3)];
    const created = { "demo/T-1": "2026-03-10", "demo/T-2": "2026-03-09", "demo/T-3": "2026-03-08" };

    const model = await collect(rows, created, []);

    // merges at 18:30, 17:30, 16:30 on the 10th: 18.5h, 41.5h, 64.5h after midnight starts
    expect(model.flow?.taskToMergeP50Hours).toBe(41.5);
    expect(model.flow?.merged).toBe(3);
    expect(model.flow?.missing).toBe(0);
  });

  it("counts a run without a task, or whose task cannot be read, as missing and never imputes it", async () => {
    const rows = [merged(1, "demo/T-1", 1), merged(2, "", 2), merged(3, "demo/T-9", 3)];

    const model = await collect(rows, { "demo/T-1": "2026-03-10" }, []);

    expect(model.flow?.merged).toBe(3);
    expect(model.flow?.missing).toBe(2);
    expect(model.flow?.taskToMergeP50Hours).toBe(18.5);
  });

  it("leaves runs merged before the window and unmerged runs out", async () => {
    const old = merged(1, "demo/T-1", 10);
    const stopped = watchRow({ pr: 2, phase: "done", phaseSince: hoursAgo(1), outcome: { kind: "stopped", reason: "x" } });

    const model = await collect([old, stopped], { "demo/T-1": "2026-03-10" }, []);

    expect(model.flow?.merged).toBe(0);
  });

  it("divides merges by implementer hours, counting only implementer profiles and clipping to the window", async () => {
    const rows = [merged(1, "demo/T-1", 1), merged(2, "demo/T-2", 2)];
    const spans = [
      span("implementer", 10, 4), // 2h inside the 6h window after clipping the start
      span("bd-implementer", 3, 1), // 2h
      span("implementer-lite", 1), // live: 1h to now
      span("reviewer", 5, 1), // not an implementer
      span("implementer", 20, 8), // wholly before the window
    ];

    const model = await collect(rows, {}, spans);

    expect(model.flow?.implementerHours).toBe(5);
    expect(model.flow?.mergesPerSlotHour).toBe(0.4);
  });

  it("reports no rate when no implementer hours were measured", async () => {
    const model = await collect([merged(1, "demo/T-1", 1)], {}, [span("reviewer", 3, 1)]);

    expect(model.flow?.mergesPerSlotHour).toBeUndefined();
  });

  it("skips an exited agent with no end time and counts it as unmeasured", async () => {
    const model = await collect([], {}, [{ profile: "implementer", startedAt: hoursAgo(3), live: false }]);

    expect(model.flow?.implementerHours).toBe(0);
    expect(model.flow?.unmeasured).toBe(1);
  });

  it("notes a gap and leaves the section out when a port fails", async () => {
    const model = await collectDigest({
      sources: fakeSources({ flow: { taskCreated: async () => undefined, roster: async () => Promise.reject(new Error("broker down")) } }),
      now: NOW,
      windowMinutes: WINDOW_MINUTES,
      slot: SLOT,
    });

    expect(model.flow).toBeUndefined();
    expect(model.gaps).toContain("flow roster: broker down");
  });

  it("renders both numbers and the missing count", async () => {
    const model = await collect([merged(1, "demo/T-1", 1), merged(2, "", 2)], { "demo/T-1": "2026-03-10" }, [span("implementer", 4, 0.5)]);

    const markdown = renderMarkdown(rankDigest(model));

    expect(markdown).toContain("## Flow");
    expect(markdown).toContain("Task to merge p50: 18.5h (1 of 2 merges missing a task date)");
    expect(markdown).toContain("Merges per implementer slot-hour: 0.57 (2 merges, 3.5 hours)");
  });
});
