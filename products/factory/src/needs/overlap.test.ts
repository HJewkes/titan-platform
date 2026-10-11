import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeByKeys } from "@titan-design/owner-queue";
import { describe, expect, it } from "vitest";
import { GATE_COUNT, MORNING_COUNT, OVERLAP_LINES, SEATS, TASK_COUNT, decisionTask, gateItem, seatQueueFile } from "../test-support/owner-queue-10-05.js";
import { decisionTaskItem } from "./active-work-source.js";
import { createMorningSource } from "./morning-source.js";
import { overlapReport, renderOverlapReport, subjectOf } from "./overlap.js";

const range = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);

async function snapshot10_05() {
  const dir = mkdtempSync(join(tmpdir(), "overlap-10-05-"));
  try {
    for (const seat of SEATS) writeFileSync(join(dir, `${seat}.md`), seatQueueFile(seat));
    const morning = await createMorningSource({ dir }).open();
    return [...range(GATE_COUNT).map(gateItem), ...morning, ...range(TASK_COUNT).map((n) => decisionTaskItem(decisionTask(n), false))];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("overlapReport on a synthetic 10-05 queue", () => {
  it("names every gate/Morning and Morning/task overlap and whether merging folded it", async () => {
    const items = await snapshot10_05();

    const report = renderOverlapReport(overlapReport(items));

    expect(items).toHaveLength(GATE_COUNT + MORNING_COUNT + TASK_COUNT);
    expect(report.split("\n")).toEqual(["7 overlaps, 5 merged, 2 shown more than once", ...OVERLAP_LINES]);
  });

  it("agrees with merge-by-keys on how many items the owner sees", async () => {
    const items = await snapshot10_05();

    expect(mergeByKeys(items)).toHaveLength(items.length - 5);
  });
});

describe("subjectOf", () => {
  it("reads a PR by repo name and number, whatever owner or head the key carries", () => {
    expect(subjectOf("pr:Acme/Widgets#7@abc")).toBe("pr:widgets#7");
    expect(subjectOf("pr:widgets#7")).toBe("pr:widgets#7");
    expect(subjectOf("seat:a")).toBeUndefined();
  });
});
