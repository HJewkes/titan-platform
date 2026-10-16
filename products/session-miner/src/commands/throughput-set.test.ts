import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectSetTasks } from "./throughput-set.js";

const ALLOWED = ["alpha", "beta"];

let root: string;

interface TaskFixture {
  id: string;
  status?: string;
  tags?: string[];
  parent?: string;
  kind?: string;
  estimate?: number;
}

function writeTask(initiative: string, task: TaskFixture): void {
  const tasksDir = path.join(root, initiative, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const status = task.status ?? "open";
  const lines = [`id: ${task.id}`, `title: ${task.id}`, "priority: 1", `status: ${status}`, "created: 2026-08-01", "updated: 2026-09-01"];
  lines.push(`done_at: ${status === "done" ? "2026-09-02T00:00:00Z" : "null"}`);
  if (task.parent) lines.push(`parent: ${task.parent}`);
  if (task.kind) lines.push(`kind: ${task.kind}`);
  if (task.estimate !== undefined) lines.push(`estimate: ${task.estimate}`);
  if (task.tags) lines.push("tags:", ...task.tags.map((tag) => `  - "${tag}"`));
  writeFileSync(path.join(tasksDir, `${task.id}.yml`), `${lines.join("\n")}\n`);
}

const ids = (selection: { tasks: { taskId: string }[] }): string[] => selection.tasks.map((task) => task.taskId).sort();

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "throughput-set-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("selectSetTasks by parent", () => {
  beforeEach(() => {
    writeTask("alpha", { id: "A-1" });
    writeTask("alpha", { id: "A-2", parent: "A-1" });
    writeTask("alpha", { id: "A-3", tags: ["parent:A-2"] });
    writeTask("alpha", { id: "A-4", parent: "A-1", status: "done" });
    writeTask("beta", { id: "B-1", tags: ["epic:A-1"] });
    writeTask("alpha", { id: "A-5" });
  });

  it("returns open descendants at every depth and across initiatives, never the parent", () => {
    const selection = selectSetTasks(root, ALLOWED, { parent: "A-1" });

    expect(ids(selection)).toEqual(["A-2", "A-3", "B-1"]);
  });

  it("lists a done descendant under skippedDone instead of forecasting it", () => {
    const selection = selectSetTasks(root, ALLOWED, { parent: "A-1" });

    expect(selection.skippedDone).toEqual(["A-4"]);
    expect(selection.notFound).toEqual([]);
  });

  it("reports a parent id that exists nowhere as notFound", () => {
    const selection = selectSetTasks(root, ALLOWED, { parent: "Z-9" });

    expect(selection.tasks).toEqual([]);
    expect(selection.notFound).toEqual(["Z-9"]);
  });
});

describe("selectSetTasks by milestone", () => {
  beforeEach(() => {
    writeTask("alpha", { id: "A-1", tags: ["milestone:M4"] });
    writeTask("alpha", { id: "A-2", tags: ["milestone:M4,"] });
    writeTask("alpha", { id: "A-3", tags: ["milestone:M4-candidate"] });
    writeTask("alpha", { id: "A-4", tags: ["milestone:M4"], status: "done" });
    writeTask("beta", { id: "B-1", tags: ["milestone:M4"] });
  });

  it("refuses a milestone that recurs across initiatives without an initiative, naming both", () => {
    expect(() => selectSetTasks(root, ALLOWED, { milestone: "M4" })).toThrow(/alpha, beta/);
  });

  it("returns one initiative's open tasks on an exact tag match, trailing punctuation trimmed", () => {
    const selection = selectSetTasks(root, ALLOWED, { milestone: "M4", initiative: "alpha" });

    expect(ids(selection)).toEqual(["A-1", "A-2"]);
    expect(selection.skippedDone).toEqual(["A-4"]);
  });

  it("needs no initiative when the milestone lives in one initiative", () => {
    const selection = selectSetTasks(root, ALLOWED, { milestone: "M4-candidate" });

    expect(ids(selection)).toEqual(["A-3"]);
  });
});

describe("selectSetTasks by explicit ids", () => {
  it("returns found ids and lists unknown or non-allowlisted ones as notFound", () => {
    writeTask("alpha", { id: "A-9", estimate: 2 });
    writeTask("gamma", { id: "G-1" });

    const selection = selectSetTasks(root, ALLOWED, { tasks: ["A-9", "Z-1", "G-1"] });

    expect(selection.tasks).toEqual([{ taskId: "A-9", kind: null, estimate: 2, initiative: "alpha" }]);
    expect(selection.notFound).toEqual(["Z-1", "G-1"]);
  });

  it("takes the kind from the kind: tag before the kind field", () => {
    writeTask("alpha", { id: "A-1", tags: ["kind:security"] });
    writeTask("alpha", { id: "A-2", tags: ["kind:security"], kind: "feature" });
    writeTask("alpha", { id: "A-3", kind: "feature" });

    const selection = selectSetTasks(root, ALLOWED, { tasks: ["A-1", "A-2", "A-3"] });

    expect(selection.tasks.map((task) => task.kind)).toEqual(["security", "security", "feature"]);
  });

  it("refuses an id that appears in two initiatives", () => {
    writeTask("alpha", { id: "A-1" });
    writeTask("beta", { id: "A-1" });

    expect(() => selectSetTasks(root, ALLOWED, { tasks: ["A-1"] })).toThrow(/A-1 appears in both alpha and beta/);
  });

  it("counts an unparseable task file without failing the selection", () => {
    writeTask("alpha", { id: "A-1" });
    writeFileSync(path.join(root, "alpha", "tasks", "broken.yml"), "id: [\n");

    const selection = selectSetTasks(root, ALLOWED, { tasks: ["A-1"] });

    expect(ids(selection)).toEqual(["A-1"]);
    expect(selection.unparsed.map((entry) => entry.file)).toEqual([path.join("alpha", "tasks", "broken.yml")]);
  });
});
