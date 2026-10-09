import { describe, expect, it } from "vitest";
import { checkEdges, readEdges } from "./edges.js";
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

describe("readEdges", () => {
  it("returns no edges for a task with neither fields nor edge tags", () => {
    expect(readEdges(task("AA-1"))).toEqual({ parent: null, dep: [] });
  });

  it("reads the fields when present", () => {
    const edges = readEdges(task("AA-1", { parent: "AA-2", dep: ["AA-3", "BB-4"] }));
    expect(edges).toEqual({ parent: "AA-2", dep: ["AA-3", "BB-4"] });
  });

  it.each(["epic:AA-9", "parent:AA-9"])("reads the parent from a %s tag", (tag) => {
    expect(readEdges(task("AA-1", { tags: ["later", tag] })).parent).toBe("AA-9");
  });

  it.each(["dep:AA-9", "blocked-by:AA-9"])("reads a dep from a %s tag", (tag) => {
    expect(readEdges(task("AA-1", { tags: [tag, "later"] })).dep).toEqual(["AA-9"]);
  });

  it("merges dep: and blocked-by: tags and drops repeats", () => {
    const tags = ["dep:AA-2", "blocked-by:AA-3", "blocked-by:AA-2"];
    expect(readEdges(task("AA-1", { tags })).dep).toEqual(["AA-2", "AA-3"]);
  });

  it("lets the parent field win over an epic tag", () => {
    expect(readEdges(task("AA-1", { parent: "AA-2", tags: ["epic:AA-3"] })).parent).toBe("AA-2");
  });

  it("lets an empty dep field win over dep tags", () => {
    expect(readEdges(task("AA-1", { dep: [], tags: ["dep:AA-3"] })).dep).toEqual([]);
  });

  it("ignores blocks: tags, which name the inverse edge", () => {
    expect(readEdges(task("AA-1", { tags: ["blocks:AA-2"] }))).toEqual({ parent: null, dep: [] });
  });

  it("ignores an edge tag whose value is not a task id", () => {
    expect(readEdges(task("AA-1", { tags: ["epic:some-name"] })).parent).toBeNull();
  });
});

describe("checkEdges", () => {
  const tasks = [task("AA-1"), task("AA-2"), task("AA-3"), task("BB-1")];

  it("accepts a change whose edges resolve and form no cycle", () => {
    const result = checkEdges(tasks, { id: "AA-1", parent: "AA-2", dep: ["AA-3"] });
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it("reports each unknown id with its field", () => {
    const result = checkEdges(tasks, { id: "AA-1", parent: "AA-8", dep: ["AA-2", "AA-9"] });
    expect(result.errors).toEqual([
      { kind: "unknown-id", id: "AA-1", field: "parent", ref: "AA-8" },
      { kind: "unknown-id", id: "AA-1", field: "dep", ref: "AA-9" },
    ]);
  });

  it("reports a self-dep as a one-task cycle", () => {
    const result = checkEdges(tasks, { id: "AA-1", dep: ["AA-1"] });
    expect(result.errors).toEqual([{ kind: "cycle", field: "dep", ids: ["AA-1"] }]);
  });

  it("reports a self-parent as a one-task cycle", () => {
    const result = checkEdges(tasks, { id: "AA-1", parent: "AA-1" });
    expect(result.errors).toEqual([{ kind: "cycle", field: "parent", ids: ["AA-1"] }]);
  });

  it("names every id on a 3-cycle of deps, including one read from tags", () => {
    const graph = [task("AA-1"), task("AA-2", { dep: ["AA-3"] }), task("AA-3", { tags: ["blocked-by:AA-1"] })];
    const result = checkEdges(graph, { id: "AA-1", dep: ["AA-2"] });
    expect(result.errors).toEqual([{ kind: "cycle", field: "dep", ids: ["AA-1", "AA-2", "AA-3"] }]);
  });

  it("names every id on a 3-cycle of parents", () => {
    const graph = [task("AA-1"), task("AA-2", { parent: "AA-3" }), task("AA-3", { tags: ["epic:AA-1"] })];
    const result = checkEdges(graph, { id: "AA-1", parent: "AA-2" });
    expect(result.errors).toEqual([{ kind: "cycle", field: "parent", ids: ["AA-1", "AA-2", "AA-3"] }]);
  });

  it("does not report a cycle elsewhere in the graph that the change does not touch", () => {
    const graph = [task("AA-1"), task("AA-2", { dep: ["AA-3"] }), task("AA-3", { dep: ["AA-2"] })];
    expect(checkEdges(graph, { id: "AA-1", dep: ["AA-2"] }).errors).toEqual([]);
  });

  it("accepts a diamond of deps, which is not a cycle", () => {
    const graph = [task("AA-1"), task("AA-2", { dep: ["AA-3"] }), task("AA-3"), task("AA-4", { dep: ["AA-3"] })];
    expect(checkEdges(graph, { id: "AA-1", dep: ["AA-2", "AA-4"] }).errors).toEqual([]);
  });

  it("accepts a cross-initiative dep with no warning", () => {
    expect(checkEdges(tasks, { id: "AA-1", dep: ["BB-1"] })).toEqual({ errors: [], warnings: [] });
  });

  it("warns, without failing, on a cross-initiative parent", () => {
    const result = checkEdges(tasks, { id: "AA-1", parent: "BB-1" });
    expect(result).toEqual({
      errors: [],
      warnings: [{ kind: "cross-initiative-parent", id: "AA-1", parent: "BB-1" }],
    });
  });

  it("starts the cycle at the changed task and follows the other tasks' current edges", () => {
    const graph = [task("AA-1", { tags: ["dep:AA-2"] }), task("AA-2", { dep: ["AA-3"] }), task("AA-3")];
    const result = checkEdges(graph, { id: "AA-3", dep: ["AA-1"] });
    expect(result.errors).toEqual([{ kind: "cycle", field: "dep", ids: ["AA-3", "AA-1", "AA-2"] }]);
  });

  it("clears a parent when the change sets it to null", () => {
    const graph = [task("AA-1", { parent: "BB-1" }), task("BB-1")];
    expect(checkEdges(graph, { id: "AA-1", parent: null }).warnings).toEqual([]);
  });

  it("checks a task that is not yet in the list", () => {
    expect(checkEdges(tasks, { id: "AA-7", parent: "AA-1", dep: ["AA-2"] }).errors).toEqual([]);
  });
});
