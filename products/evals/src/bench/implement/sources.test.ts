import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveSources } from "./sources.js";

let tasksDir: string;

beforeEach(() => {
  tasksDir = mkdtempSync(join(tmpdir(), "bench-tasks-"));
});

afterEach(() => rmSync(tasksDir, { recursive: true, force: true }));

const sourcesFor = () => liveSources({ factoryDb: join(tasksDir, "none.sqlite3"), repoSlug: "o/demo", tasksDir, repoDir: tasksDir, mainRef: "main" });

describe("task files", () => {
  it("reads a task with no estimate and no done_when as unestimated and unbriefed", () => {
    writeFileSync(join(tasksDir, "TP-1.yml"), "id: TP-1\ntitle: Cap the retries\nstatus: done\n");

    expect(sourcesFor().task("TP-1")).toEqual({ title: "Cap the retries", doneWhen: null, estimate: null });
  });

  it("reads a list done_when as one line per item", () => {
    writeFileSync(join(tasksDir, "TP-2.yml"), "title: Cap\nestimate: 2\ndone_when:\n  - stops at three\n  - logs the cap\n");

    expect(sourcesFor().task("TP-2")).toEqual({ title: "Cap", doneWhen: "- stops at three\n- logs the cap", estimate: 2 });
  });

  it("answers undefined for a task with no file", () => {
    expect(sourcesFor().task("TP-3")).toBeUndefined();
  });
});
