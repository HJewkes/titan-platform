import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TaskKeyEntry } from "@titan-design/pm";

/** An archived task's file is `<ID>.yml`, so its id needs no parse. */
const TASK_FILE = /^([A-Z][A-Z0-9]*-\d+)\.yml$/;

const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

async function idsIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).flatMap((file) => TASK_FILE.exec(file)?.[1] ?? []);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Every `<root>/<initiative>/tasks/archive/<ID>.yml`, read-only; undefined when the root cannot be listed. */
export async function archivedTasks(activeRoot: string): Promise<TaskKeyEntry[] | undefined> {
  try {
    const slugs = (await readdir(activeRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
    const lists = await Promise.all(slugs.map(async (slug) => (await idsIn(join(activeRoot, slug, "tasks", "archive"))).map((id) => ({ id, initiative: slug }))));
    return lists.flat();
  } catch {
    return undefined;
  }
}
