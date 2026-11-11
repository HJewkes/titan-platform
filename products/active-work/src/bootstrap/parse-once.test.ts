import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { archiveStaleTasks } from "./archive-tasks.js";
import { assembleBootstrap } from "./prompt.js";
import { withTempActiveRoot } from "../test-support/test-helpers.js";

const SLUG = "sample-initiative";
const NOW = new Date("2026-05-12T16:00:00Z");
const GOLDEN = path.join(
  import.meta.dirname,
  "fixtures",
  "parse-once-prompt.golden.md"
);
const TASK_COUNT = 50;

function taskYaml(n: number): string {
  const stale = n % 10 === 0;
  return [
    `id: PO-${n}`,
    `title: 'Synthetic task ${n}'`,
    `priority: ${n}`,
    `status: ${stale ? "done" : "open"}`,
    `created: '2026-01-01'`,
    `updated: '2026-01-02'`,
    `done_at: ${stale ? "'2026-01-02'" : "null"}`,
    "",
  ].join("\n");
}

async function seedTasks(activeRoot: string): Promise<string> {
  const tasksDir = path.join(activeRoot, SLUG, "tasks");
  await fs.rm(tasksDir, { recursive: true, force: true });
  await fs.mkdir(tasksDir, { recursive: true });
  for (let n = 1; n <= TASK_COUNT; n += 1) {
    await fs.writeFile(path.join(tasksDir, `PO-${n}.yml`), taskYaml(n));
  }
  return tasksDir;
}

/** The prompt stamps wall-clock time and the temp root; neither is under test. */
function normalize(prompt: string, activeRoot: string): string {
  return prompt
    .replaceAll(activeRoot, "<ROOT>")
    .replace(/^- Today: .*$/m, "- Today: <DATE>")
    .replace(/^- Bootstrap: .*$/m, "- Bootstrap: <TS>");
}

let readFileSpy: MockInstance<typeof fs.readFile>;

function taskReads(tasksDir: string): string[] {
  return readFileSpy.mock.calls
    .map(([file]) => String(file))
    .filter((file) => file.startsWith(tasksDir));
}

describe("bootstrap parses each task file once", () => {
  beforeEach(() => {
    readFileSpy = vi.spyOn(fs, "readFile");
  });

  afterEach(() => {
    readFileSpy.mockRestore();
  });

  it("reads every task file exactly once and renders the same prompt as a fresh load", async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const tasksDir = await seedTasks(activeRoot);
      const archived = await archiveStaleTasks(path.join(activeRoot, SLUG), {
        retentionDays: 30,
        now: NOW,
      });
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SLUG,
        now: NOW,
        includeLiveStatus: false,
        archivedTaskIds: archived.archivedIds,
        loadedTasks: { tasks: archived.tasks, malformed: archived.malformed },
      });

      const reads = taskReads(tasksDir);
      expect(reads).toHaveLength(TASK_COUNT);
      expect(new Set(reads).size).toBe(TASK_COUNT);

      expect(archived.archivedIds).toHaveLength(5);
      expect(archived.tasks).toHaveLength(TASK_COUNT - 5);

      const golden = await fs.readFile(GOLDEN, "utf8");
      expect(normalize(prompt, activeRoot)).toBe(golden);
    });
  });
});
