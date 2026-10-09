import { describe, expect, it } from "vitest";
import { criticalPath, taskTree } from "./graph.js";
import type { Task } from "./task.js";

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `task ${id}`,
  priority: 1,
  status: "open",
  created: "2026-01-01",
  updated: "2026-01-01",
  done_at: null,
  ...extra,
});

/** The CC-627 fixture shape: a milestone there is a deliverable here. */
const T = (id: string, estimate: number | undefined, dep: string[] = [], deliverable = "m1"): Task =>
  task(id, { ...(estimate !== undefined && { estimate }), dep, deliverables: [deliverable] });

const floatsOf = (tasks: Task[], deliverable?: string) =>
  Object.fromEntries(criticalPath(tasks, { deliverable }).tasks.map((t) => [t.id, t.float]));

describe("criticalPath total float (CC-627)", () => {
  it.each<{ name: string; tasks: Task[]; floats: Record<string, number>; path: string[]; length: number }>([
    {
      name: "a linear chain is all critical",
      tasks: [T("EX-1", 2), T("EX-2", 3, ["EX-1"]), T("EX-3", 1, ["EX-2"])],
      floats: { "EX-1": 0, "EX-2": 0, "EX-3": 0 },
      path: ["EX-1", "EX-2", "EX-3"],
      length: 6,
    },
    {
      name: "a diamond gives the short branch positive float",
      tasks: [T("EX-1", 1), T("EX-2", 3, ["EX-1"]), T("EX-3", 1, ["EX-1"]), T("EX-4", 2, ["EX-2", "EX-3"])],
      floats: { "EX-1": 0, "EX-2": 0, "EX-3": 2, "EX-4": 0 },
      path: ["EX-1", "EX-2", "EX-4"],
      length: 6,
    },
    {
      name: "independent tasks float against the longest",
      tasks: [T("EX-1", 1), T("EX-2", 3)],
      floats: { "EX-1": 2, "EX-2": 0 },
      path: ["EX-2"],
      length: 3,
    },
    {
      name: "fractional estimates leave no rounding error",
      tasks: [T("EX-1", 0.1), T("EX-2", 0.2, ["EX-1"]), T("EX-3", 0.3)],
      floats: { "EX-1": 0, "EX-2": 0, "EX-3": 0 },
      path: ["EX-1", "EX-3", "EX-2"],
      length: 0.3,
    },
    {
      name: "a task whose two successors have different slack takes the tighter one",
      tasks: [T("EX-1", 1), T("EX-2", 3, ["EX-1"]), T("EX-3", 1, ["EX-1"])],
      floats: { "EX-1": 0, "EX-2": 0, "EX-3": 2 },
      path: ["EX-1", "EX-2"],
      length: 4,
    },
    {
      name: "a chain listed after its dependents",
      tasks: [T("EX-3", 1, ["EX-2"]), T("EX-2", 2, ["EX-1"]), T("EX-1", 1)],
      floats: { "EX-1": 0, "EX-2": 0, "EX-3": 0 },
      path: ["EX-1", "EX-2", "EX-3"],
      length: 4,
    },
    { name: "an empty input", tasks: [], floats: {}, path: [], length: 0 },
  ])("$name", ({ tasks, floats, path, length }) => {
    const result = criticalPath(tasks);

    expect(floatsOf(tasks)).toEqual(floats);
    expect(result.criticalPath).toEqual(path);
    expect(result.length).toBe(length);
    expect(result.cycles).toEqual([]);
    expect(result.lowerBound).toBe(false);
  });

  it("reports early and late start and finish for a task with float", () => {
    const tasks = [T("EX-1", 1), T("EX-2", 3, ["EX-1"]), T("EX-3", 1, ["EX-1"]), T("EX-4", 2, ["EX-2", "EX-3"])];

    expect(criticalPath(tasks).tasks.find((t) => t.id === "EX-3")).toEqual({
      id: "EX-3",
      duration: 1,
      earlyStart: 1,
      earlyFinish: 2,
      lateStart: 3,
      lateFinish: 4,
      float: 2,
    });
  });
});

describe("criticalPath cycles (CC-627)", () => {
  it.each<{ name: string; tasks: Task[]; cycles: string[][]; floats: Record<string, number> }>([
    {
      name: "a two-task cycle",
      tasks: [T("EX-1", 2), T("EX-2", 1, ["EX-3"]), T("EX-3", 1, ["EX-2"]), T("EX-4", 1)],
      cycles: [["EX-2", "EX-3"]],
      floats: { "EX-1": 0, "EX-4": 1 },
    },
    {
      name: "a three-task cycle with a task after it",
      tasks: [T("EX-1", 1, ["EX-3"]), T("EX-2", 1, ["EX-1"]), T("EX-3", 1, ["EX-2"]), T("EX-4", 2, ["EX-3"])],
      cycles: [["EX-1", "EX-2", "EX-3"]],
      floats: { "EX-4": 0 },
    },
    {
      name: "a task depending on itself",
      tasks: [T("EX-1", 1, ["EX-1"]), T("EX-2", 1)],
      cycles: [["EX-1"]],
      floats: { "EX-2": 0 },
    },
    {
      name: "two separate cycles",
      tasks: [T("EX-1", 1, ["EX-2"]), T("EX-2", 1, ["EX-1"]), T("EX-3", 1, ["EX-4"]), T("EX-4", 1, ["EX-3"])],
      cycles: [
        ["EX-1", "EX-2"],
        ["EX-3", "EX-4"],
      ],
      floats: {},
    },
  ])("reports $name without throwing and still floats the rest", ({ tasks, cycles, floats }) => {
    expect(criticalPath(tasks).cycles).toEqual(cycles);
    expect(floatsOf(tasks)).toEqual(floats);
  });

  it("flags the path length as a lower bound, since a cycle adds no points", () => {
    const tasks = [T("EX-1", 1, ["EX-2"]), T("EX-2", 5, ["EX-1"]), T("EX-3", 2, ["EX-1"])];

    const result = criticalPath(tasks);

    expect(result.length).toBe(2);
    expect(result.lowerBound).toBe(true);
  });
});

describe("criticalPath deps outside the set (CC-627)", () => {
  it("treats a dep on another deliverable as satisfied and reports it", () => {
    const tasks = [T("EX-1", 5, [], "m2"), T("EX-2", 1, ["EX-1"]), T("EX-3", 2)];

    const result = criticalPath(tasks, { deliverable: "m1" });

    expect(floatsOf(tasks, "m1")).toEqual({ "EX-2": 1, "EX-3": 0 });
    expect(result.externalDeps).toEqual([{ task: "EX-2", dep: "EX-1" }]);
    expect(result.length).toBe(2);
  });

  it("treats a dep on an unknown task as satisfied", () => {
    const result = criticalPath([T("EX-1", 1, ["EX-90"]), T("EX-2", 1, ["EX-1"])]);

    expect(result.criticalPath).toEqual(["EX-1", "EX-2"]);
    expect(result.externalDeps).toEqual([{ task: "EX-1", dep: "EX-90" }]);
  });

  it("takes every open task when no deliverable is named", () => {
    expect(floatsOf([T("EX-1", 1, [], "m2"), T("EX-2", 1, ["EX-1"])])).toEqual({ "EX-1": 0, "EX-2": 0 });
  });
});

describe("criticalPath estimates (CC-627)", () => {
  it.each([
    { name: "missing", estimate: undefined },
    { name: "NaN", estimate: Number.NaN },
    { name: "infinite", estimate: Number.POSITIVE_INFINITY },
    { name: "negative", estimate: -2 },
  ])("a $name estimate is duration 0 and reported", ({ estimate }) => {
    const result = criticalPath([T("EX-1", 2), T("EX-2", estimate, ["EX-1"]), T("EX-3", 1, ["EX-2"])]);

    expect(result.tasks.find((t) => t.id === "EX-2")?.duration).toBe(0);
    expect(result.criticalPath).toEqual(["EX-1", "EX-2", "EX-3"]);
    expect(result.length).toBe(3);
    expect(result.unestimated).toEqual(["EX-2"]);
  });

  it("keeps the first of two tasks with one id", () => {
    const result = criticalPath([T("EX-1", 2), T("EX-1", 9)]);

    expect(result.tasks.map((t) => t.duration)).toEqual([2]);
  });
});

describe("criticalPath over pm tasks", () => {
  it.each(["done", "wont-do"])("leaves out a %s task and treats a dep on it as satisfied", (status) => {
    const tasks = [task("EX-1", { estimate: 5, status }), T("EX-2", 1, ["EX-1"])];

    const result = criticalPath(tasks);

    expect(result.tasks.map((t) => t.id)).toEqual(["EX-2"]);
    expect(result.externalDeps).toEqual([{ task: "EX-2", dep: "EX-1" }]);
    expect(result.length).toBe(1);
  });

  it("keeps an icebox task, which is not closed", () => {
    expect(floatsOf([task("EX-1", { estimate: 1, status: "icebox" })])).toEqual({ "EX-1": 0 });
  });

  it("reads deps from dep: tags when the task has no dep field", () => {
    const tasks = [task("EX-1", { estimate: 2 }), task("EX-2", { estimate: 1, tags: ["dep:EX-1"] })];

    expect(criticalPath(tasks).length).toBe(3);
  });

  it("selects by the deliverables field and never by a deliverable: tag", () => {
    const tasks = [task("EX-1", { estimate: 1, tags: ["deliverable:m1"] }), T("EX-2", 1)];

    expect(criticalPath(tasks, { deliverable: "m1" }).tasks.map((t) => t.id)).toEqual(["EX-2"]);
  });
});

describe("taskTree", () => {
  it("returns null for an unknown root", () => {
    expect(taskTree([task("EX-1")], "EX-9")).toBeNull();
  });

  it("nests children by parent, depth-first in input order, with status and estimate", () => {
    const tasks = [
      task("EX-1", { estimate: 3 }),
      task("EX-2", { parent: "EX-1", status: "done", estimate: 1 }),
      task("EX-3", { parent: "EX-1" }),
      task("EX-4", { parent: "EX-2", estimate: 2 }),
      task("EX-5"),
    ];

    expect(taskTree(tasks, "EX-1")).toEqual({
      id: "EX-1",
      title: "task EX-1",
      status: "open",
      estimate: 3,
      depth: 0,
      children: [
        {
          id: "EX-2",
          title: "task EX-2",
          status: "done",
          estimate: 1,
          depth: 1,
          children: [{ id: "EX-4", title: "task EX-4", status: "open", estimate: 2, depth: 2, children: [] }],
        },
        { id: "EX-3", title: "task EX-3", status: "open", estimate: null, depth: 1, children: [] },
      ],
    });
  });

  it("reads the parent from an epic: tag when the task has no parent field", () => {
    const tree = taskTree([task("EX-1"), task("EX-2", { tags: ["epic:EX-1"] })], "EX-1");

    expect(tree?.children.map((c) => c.id)).toEqual(["EX-2"]);
  });

  it("ends the walk at a parent cycle instead of looping", () => {
    const tasks = [task("EX-1", { parent: "EX-2" }), task("EX-2", { parent: "EX-1" })];

    const tree = taskTree(tasks, "EX-1");

    expect(tree?.children.map((c) => c.id)).toEqual(["EX-2"]);
    expect(tree?.children[0]?.children).toEqual([]);
  });
});
