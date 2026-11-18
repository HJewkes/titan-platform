import { describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "./beat-slots.js";

const task = (start: string, end: string) => ({ id: "build", label: "Build", start, end });

describe("BEAT_SLOTS.gantt", () => {
  it("rejects a task that ends before it starts", () => {
    const result = BEAT_SLOTS.gantt.safeParse({ tasks: [task("2026-03-10", "2026-03-09")] });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain("a gantt task must not end before it starts");
  });

  it("accepts a task that starts and ends on the same day", () => {
    const result = BEAT_SLOTS.gantt.safeParse({ tasks: [task("2026-03-10", "2026-03-10")] });

    expect(result.success).toBe(true);
  });

  it("defaults milestones to an empty list", () => {
    const result = BEAT_SLOTS.gantt.parse({ tasks: [task("2026-03-01", "2026-03-10")] });

    expect(result.milestones).toEqual([]);
  });
});
