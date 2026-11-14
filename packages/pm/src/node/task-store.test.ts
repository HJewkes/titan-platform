import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInitiativeTasks } from "./index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pm-task-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function taskYaml(id: string, extra = ""): string {
  return `id: ${id}\ntitle: Task ${id}\npriority: 1\nstatus: open\ncreated: 2026-01-02\nupdated: 2026-01-03\ndone_at: null\n${extra}`;
}

function writeTask(rel: string, text: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

describe("readInitiativeTasks", () => {
  it("returns malformed YAML and schema failures in unparsed with reasons, and still resolves", async () => {
    writeTask("alpha/tasks/AL-1.yml", taskYaml("AL-1"));
    writeTask("alpha/tasks/AL-2.yml", "id: [unclosed\n");
    writeTask("alpha/tasks/AL-3.yml", "id: AL-3\ntitle: no priority\n");

    const result = await readInitiativeTasks(root, "alpha");

    expect(result.tasks.map((row) => row.task.id)).toEqual(["AL-1"]);
    expect(result.unparsed.map((row) => [row.initiative, row.file])).toEqual([
      ["alpha", "alpha/tasks/AL-2.yml"],
      ["alpha", "alpha/tasks/AL-3.yml"],
    ]);
    expect(result.unparsed[0]?.reason).toMatch(/^yaml: /);
    expect(result.unparsed[1]?.reason).toContain("priority:");
  });

  it("leaves the archive out by default and appends it, flagged, after every live row on request", async () => {
    writeTask("alpha/tasks/AL-2.yml", taskYaml("AL-2"));
    writeTask("alpha/tasks/archive/AL-1.yml", taskYaml("AL-1"));

    const live = await readInitiativeTasks(root, "alpha");
    const all = await readInitiativeTasks(root, "alpha", { archive: true });

    expect(live.tasks.map((row) => row.file)).toEqual(["alpha/tasks/AL-2.yml"]);
    expect(all.tasks.map((row) => [row.file, row.archived])).toEqual([
      ["alpha/tasks/AL-2.yml", false],
      ["alpha/tasks/archive/AL-1.yml", true],
    ]);
  });

  it("sorts by filename, reads .yml and .yaml, and ignores other files", async () => {
    writeTask("alpha/tasks/b.yml", taskYaml("AL-2"));
    writeTask("alpha/tasks/a.yaml", taskYaml("AL-1"));
    writeTask("alpha/tasks/c.yml", taskYaml("AL-3"));
    writeTask("alpha/tasks/notes.txt", "not a task");

    const result = await readInitiativeTasks(root, "alpha");

    expect(result.tasks.map((row) => row.file)).toEqual(["alpha/tasks/a.yaml", "alpha/tasks/b.yml", "alpha/tasks/c.yml"]);
    expect(result.unparsed).toEqual([]);
  });

  it("reports a missing tasks folder as missing, and throws when tasks is not a folder", async () => {
    mkdirSync(path.join(root, "alpha"));
    writeTask("beta/tasks", "a file, not a folder");

    expect(await readInitiativeTasks(root, "alpha", { archive: true })).toEqual({ tasks: [], unparsed: [], missing: true });
    await expect(readInitiativeTasks(root, "beta")).rejects.toThrow();
  });

  it("treats a missing archive folder as no archive rows", async () => {
    writeTask("alpha/tasks/AL-1.yml", taskYaml("AL-1"));

    const result = await readInitiativeTasks(root, "alpha", { archive: true });

    expect(result.missing).toBe(false);
    expect(result.tasks.map((row) => row.task.id)).toEqual(["AL-1"]);
  });

  it("returns every row for a repeated id, and tags each slug's rows with that slug", async () => {
    writeTask("alpha/tasks/AL-1.yml", taskYaml("AL-1"));
    writeTask("alpha/tasks/archive/AL-1.yml", taskYaml("AL-1"));
    writeTask("beta/tasks/AL-1.yml", taskYaml("AL-1"));

    const alpha = await readInitiativeTasks(root, "alpha", { archive: true });
    const beta = await readInitiativeTasks(root, "beta");

    expect(alpha.tasks.map((row) => [row.initiative, row.task.id])).toEqual([
      ["alpha", "AL-1"],
      ["alpha", "AL-1"],
    ]);
    expect(beta.tasks.map((row) => row.initiative)).toEqual(["beta"]);
  });

  it("parses datetime created and done_at values and reports each file's mtime", async () => {
    const text = taskYaml("AL-1").replace("created: 2026-01-02", "created: 2026-01-02T10:00:00Z").replace("done_at: null", "done_at: 2026-01-04T11:30:00Z");
    writeTask("alpha/tasks/AL-1.yml", text.replace("status: open", "status: done"));

    const result = await readInitiativeTasks(root, "alpha");

    expect(result.unparsed).toEqual([]);
    expect(result.tasks[0]?.task.done_at).toBe("2026-01-04T11:30:00Z");
    expect(result.tasks[0]?.mtimeMs).toBeGreaterThan(0);
  });
});
