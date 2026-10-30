import { describe, expect, it } from "vitest";
import { listPage, listRow, type TaskListRow } from "./task-list.js";

// Synthetic rows; nothing here comes from a real workspace.
const row = (slug: string, id: string, stage: TaskListRow["stage"], fields: Partial<TaskListRow> = {}): TaskListRow => ({
  slug, id, title: `Task ${id}`, stage, stageReason: `Reason for ${id}`, stageGuessed: false, ...fields,
});

const ROWS = [
  row("orbit-relay", "OR-1", "review", { severity: "high", title: "Retry a dropped handshake" }),
  row("orbit-relay", "OR-2", "blocked"),
  row("orbit-relay", "OR-3", "ready", { severity: "high" }),
  row("orbit-relay", "OR-4", "ready"),
  row("garden-plan", "GP-1", "ready"),
  row("garden-plan", "GP-2", "blocked", { severity: "low" }),
];

describe("a task list row", () => {
  it("keeps only what the board renders, whatever else the staged task carries", () => {
    const staged = { ...ROWS[0]!, priority: 4, tags: ["transport"], stageRule: "open-pr", parent: "OR-9", dep: ["OR-2"], deliverables: ["relay-v1"] };
    expect(listRow(staged)).toEqual(ROWS[0]);
  });
});

describe("a task list page", () => {
  it("filters by stage, initiative, severity and text, counting what matched", () => {
    expect(listPage(ROWS, { stage: "ready", initiative: "orbit-relay" }).tasks.map((entry) => entry.id)).toEqual(["OR-3", "OR-4"]);
    expect(listPage(ROWS, { severity: "high" }).tasks.map((entry) => entry.id)).toEqual(["OR-1", "OR-3"]);
    expect(listPage(ROWS, { q: "HANDSHAKE" }).tasks.map((entry) => entry.id)).toEqual(["OR-1"]);
    expect(listPage(ROWS, { stage: "blocked" }).counts).toEqual({ blocked: 2, ready: 0, "in-progress": 0, review: 0, done: 0 });
  });

  it("sends limit rows in the given order with a cursor to the rest, and still counts every match", () => {
    const page = listPage(ROWS, { limit: 2 });
    expect(page.tasks.map((entry) => entry.id)).toEqual(["OR-1", "OR-2"]);
    expect(page.nextCursor).not.toBeNull();
    expect(page.counts).toEqual({ blocked: 2, ready: 3, "in-progress": 0, review: 1, done: 0 });
  });

  it("walks every matching row once by following the cursor, ending on a null cursor", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < ROWS.length; pages++) {
      const page = listPage(ROWS, { limit: 4, ...(cursor ? { cursor } : {}) });
      seen.push(...page.tasks.map((entry) => entry.id));
      cursor = page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(ROWS.map((entry) => entry.id));
  });

  it("pages the filtered rows, not every row", () => {
    const first = listPage(ROWS, { stage: "ready", limit: 2 });
    const second = listPage(ROWS, { stage: "ready", limit: 2, cursor: first.nextCursor! });
    expect([...first.tasks, ...second.tasks].map((entry) => entry.id)).toEqual(["OR-3", "OR-4", "GP-1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("sends 50 rows by default", () => {
    const many = Array.from({ length: 250 }, (_, n) => row("orbit-relay", `OR-${n + 10}`, "ready"));
    const page = listPage(many, {});
    expect(page.tasks).toHaveLength(50);
    expect(page.counts.ready).toBe(250);
  });

  it("names every initiative with a row, whatever the filters", () => {
    expect(listPage(ROWS, { initiative: "garden-plan", stage: "review" }).initiatives).toEqual(["garden-plan", "orbit-relay"]);
  });
});
