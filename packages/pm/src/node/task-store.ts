import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { TaskSchema } from "../task.js";
import type { Task } from "../task.js";

/*
 * The one reader for an initiative's task files: <activeRoot>/<slug>/tasks/*.yml, and tasks/archive/ on request.
 * It reads exactly the slug it is handed and decides nothing about visibility or cross-initiative ids; that
 * policy stays with each caller.
 */

export interface TaskFileRow {
  initiative: string;
  /** Posix path relative to activeRoot: `<slug>/tasks/<name>` or `<slug>/tasks/archive/<name>`. */
  file: string;
  archived: boolean;
  mtimeMs: number;
  task: Task;
}

export interface UnparsedTaskFile {
  initiative: string;
  file: string;
  reason: string;
}

export interface InitiativeTasks {
  tasks: TaskFileRow[];
  unparsed: UnparsedTaskFile[];
  missing: boolean;
}

const TASK_FILE = /\.ya?ml$/;

function isMissingDir(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

// An unreadable or non-directory store throws: it is not an empty one.
async function listTaskFiles(dir: string): Promise<string[] | null> {
  try {
    return (await fs.readdir(dir)).filter((name) => TASK_FILE.test(name)).sort();
  } catch (err) {
    if (isMissingDir(err)) return null;
    throw err;
  }
}

function firstLine(err: unknown): string {
  return err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
}

/** The parsed task and its mtime, or why it would not parse; never throws. */
async function parseTaskFile(abs: string): Promise<{ task: Task; mtimeMs: number } | string> {
  let raw: string;
  let mtimeMs: number;
  try {
    [raw, { mtimeMs }] = await Promise.all([fs.readFile(abs, "utf8"), fs.stat(abs)]);
  } catch (err) {
    return `read: ${firstLine(err)}`;
  }
  let value: unknown;
  try {
    value = parse(raw);
  } catch (err) {
    return `yaml: ${firstLine(err)}`;
  }
  const result = TaskSchema.safeParse(value);
  if (result.success) return { task: result.data, mtimeMs };
  return result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

async function readOneDir(activeRoot: string, slug: string, archived: boolean): Promise<InitiativeTasks> {
  const parts = archived ? [slug, "tasks", "archive"] : [slug, "tasks"];
  const dir = path.join(activeRoot, ...parts);
  const names = await listTaskFiles(dir);
  const out: InitiativeTasks = { tasks: [], unparsed: [], missing: names === null };
  if (names === null) return out;
  const parsed = await Promise.all(names.map(async (name) => ({ name, result: await parseTaskFile(path.join(dir, name)) })));
  for (const { name, result } of parsed) {
    const file = path.posix.join(...parts, name);
    if (typeof result === "string") out.unparsed.push({ initiative: slug, file, reason: result });
    else out.tasks.push({ initiative: slug, file, archived, ...result });
  }
  return out;
}

/**
 * Every task file of one initiative, sorted by filename, live rows first and then `tasks/archive/` rows when
 * `archive` is set. A file that fails YAML or the schema lands in `unparsed`; a missing `tasks/` gives
 * `missing: true`; any other directory error throws. Repeated ids are all returned.
 */
export async function readInitiativeTasks(activeRoot: string, slug: string, options: { archive?: boolean } = {}): Promise<InitiativeTasks> {
  const live = await readOneDir(activeRoot, slug, false);
  if (live.missing || options.archive !== true) return live;
  const archive = await readOneDir(activeRoot, slug, true);
  return { tasks: [...live.tasks, ...archive.tasks], unparsed: [...live.unparsed, ...archive.unparsed], missing: false };
}
