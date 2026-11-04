import { describe, expect, it } from "vitest";
import { loadLanes } from "../../lanes-schema.js";
import { DAY } from "./daily-fakes.test-helpers.js";
import { dayWindow } from "./gather-daily.js";
import { priorityItems } from "./priorities.js";
import type { SnapshotTask } from "./task-snapshot.js";

describe("daily priorities", () => {
  const task = (id: string, priority: number | null, tags: string[], status = "open"): SnapshotTask => ({ id, title: `Synthetic task ${id}`, status, tags, priority });

  it("names each lane's two open tasks with the lowest priority rank", () => {
    const tasks = [task("DM-1", 9, ["daily"]), task("DM-2", 2, ["daily"]), task("DM-3", 1, ["daily"], "done"), task("DM-4", 5, ["daily"]), task("DM-5", 3, []), task("DM-6", null, [])];

    const items = priorityItems(tasks, loadLanes(), dayWindow(DAY));

    expect(items.map((item) => [item.id, item.lane])).toEqual([["next/DM-2", "video"], ["next/DM-4", "video"], ["next/DM-5", "factory"]]);
    expect(items[0]?.summary).toBe("DM-2 is priority 2 in the Video lane");
  });
});
