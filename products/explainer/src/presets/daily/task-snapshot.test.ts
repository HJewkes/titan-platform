import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DAY, fixtureTasks, snapshotStore } from "./daily-fakes.test-helpers.js";
import { readTaskSnapshot, takeSnapshot, taskDeltas, TaskSnapshotSchema, type SnapshotTask } from "./task-snapshot.js";

let store: ReturnType<typeof snapshotStore>;
afterEach(() => store.cleanup());

const read = () => readTaskSnapshot({ initiative: "demo", day: DAY, snapshotDir: store.dir, listTasks: async () => fixtureTasks() });
const changes = (deltas: { id: string }[]) => deltas.map((d) => d.id);

describe("task snapshot deltas over a frozen snapshot", () => {
  it("reports opened, closed, moved and owner-gated against the latest earlier snapshot", async () => {
    store = snapshotStore();

    const result = await read();

    expect(result.previousDay).toBe("2026-03-10");
    expect(changes(result.deltas)).toEqual(["task/DM-2/closed", "task/DM-3/owner-gated", "task/DM-4/moved", "task/DM-5/opened"]);
    expect(result.deltas.find((d) => d.change === "moved")).toMatchObject({ from: "open", to: "blocked" });
  });

  it("gives the same ids and stored snapshot on a second run of the same day", async () => {
    store = snapshotStore();
    const stored = path.join(store.dir, "demo", `${DAY}.json`);

    const first = await read();
    const firstFile = readFileSync(stored, "utf8");
    const second = await read();

    expect(changes(second.deltas)).toEqual(changes(first.deltas));
    expect(readFileSync(stored, "utf8")).toBe(firstFile);
    expect(TaskSnapshotSchema.parse(JSON.parse(firstFile)).tasks.map((t) => t.id)).toEqual(["DM-1", "DM-2", "DM-3", "DM-4", "DM-5"]);
  });

  it("falls back on task dates when no earlier snapshot exists, and sees no moves", () => {
    const today = takeSnapshot("demo", DAY, fixtureTasks());

    expect(changes(taskDeltas(today, undefined))).toEqual(["task/DM-2/closed", "task/DM-5/opened"]);
  });

  it("does not report a task whose column did not change", () => {
    const task: SnapshotTask = { id: "DM-9", title: "Keep the desk lit", status: "open", tags: ["owner-ask"] };

    expect(taskDeltas(takeSnapshot("demo", DAY, [task]), takeSnapshot("demo", "2026-03-10", [task]))).toEqual([]);
  });

  it("reports a task opened straight into the owner's column twice: opened, then owner-gated", () => {
    const task: SnapshotTask = { id: "DM-7", title: "Approve the courier contract", status: "open", tags: ["needs-owner"] };

    expect(changes(taskDeltas(takeSnapshot("demo", DAY, [task]), takeSnapshot("demo", "2026-03-10", [])))).toEqual(["task/DM-7/opened", "task/DM-7/owner-gated"]);
  });
});
