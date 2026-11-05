import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SnapshotTaskSchema, type SnapshotTask } from "./task-snapshot.js";

const ListSchema = z.object({ tasks: z.array(z.unknown()) });

/** Keeps the tasks the snapshot schema accepts; a malformed task file drops that task, not the day. */
export function parseTaskList(text: string): SnapshotTask[] {
  return ListSchema.parse(JSON.parse(text)).tasks.flatMap((task) => {
    const parsed = SnapshotTaskSchema.safeParse(task);
    return parsed.success ? [parsed.data] : [];
  });
}

function runToFile(argv: readonly string[], fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", fd, "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${argv.slice(0, 3).join(" ")} exited ${code}`))));
  });
}

/**
 * `active-work task list <initiative> --status all`, read-only. Stdout goes to a file, not a pipe: the CLI exits
 * before a large pipe drains, which cuts a multi-megabyte task list mid-JSON.
 */
export async function activeWorkTasks(initiative: string): Promise<SnapshotTask[]> {
  const dir = await mkdtemp(join(tmpdir(), "explainer-tasks-"));
  try {
    const file = join(dir, "tasks.json");
    const handle = await open(file, "w");
    try {
      await runToFile(["active-work", "task", "list", initiative, "--status", "all"], handle.fd);
    } finally {
      await handle.close();
    }
    return parseTaskList(await readFile(file, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
