import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { BUILT_IN_STATUSES, categoriesPath, parseCategoryRegistry, type Task } from "@titan-design/pm";
import { parse } from "yaml";
import { parseTask } from "../commands/throughput-rows.js";

/** Shepherd and reviewers tag a follow-up `follow-up:<parent id>` when they file it; the tag is an exact key, read as data. */
const FOLLOW_UP_TAG = "follow-up:";

/** One task file, live or archived, with the fields the scorecard reads. */
export interface TaskFacts {
  key: string;
  initiative: string;
  id: string;
  createdAt: string;
  doneAt: string | null;
  estimate: number | null;
  status: string;
  priority: number;
  /** The recorded `source` and `filed_by`; null on task files filed before them. */
  source: string | null;
  filedBy: string | null;
  /** Parent ids named by the task's `follow-up:` tags. */
  followUpOf: string[];
  mtimeMs: number;
}

export interface TaskLoad {
  tasks: Map<string, TaskFacts>;
  /** Bare task id to its key; ids carry the initiative's prefix, so a bare id names one task. */
  byId: Map<string, string>;
  unparsed: number;
  /** Allowlisted initiatives with no `tasks/` directory. */
  missing: string[];
  maxMtimeMs: number;
}

function taskKey(initiative: string, id: string): string {
  return `${initiative}/${id}`;
}

function taskFiles(root: string, initiative: string): string[] | null {
  const dir = path.join(root, initiative, "tasks");
  if (!existsSync(dir)) return null;
  const archive = path.join(dir, "archive");
  const inDir = (d: string) => readdirSync(d).filter((f) => f.endsWith(".yml")).sort().map((f) => path.join(d, f));
  return [...inDir(dir), ...(existsSync(archive) ? inDir(archive) : [])];
}

function factsOf(task: Task, initiative: string, mtimeMs: number): TaskFacts {
  const followUpOf = (task.tags ?? []).filter((t) => t.startsWith(FOLLOW_UP_TAG)).map((t) => t.slice(FOLLOW_UP_TAG.length)).filter(Boolean);
  return {
    key: taskKey(initiative, task.id),
    initiative,
    id: task.id,
    createdAt: task.created,
    doneAt: task.done_at ?? null,
    estimate: task.estimate ?? null,
    status: task.status,
    priority: task.priority,
    source: task.source ?? null,
    filedBy: task.filed_by ?? null,
    followUpOf,
    mtimeMs,
  };
}

/** Every task file under `<root>/<initiative>/tasks/`, `archive/` included. A file that will not parse is counted, never fatal. */
export function loadTasks(root: string, initiatives: readonly string[]): TaskLoad {
  const load: TaskLoad = { tasks: new Map(), byId: new Map(), unparsed: 0, missing: [], maxMtimeMs: 0 };
  for (const initiative of initiatives) {
    const files = taskFiles(root, initiative);
    if (files === null) {
      load.missing.push(initiative);
      continue;
    }
    for (const file of files) {
      const mtimeMs = Math.floor(statSync(file).mtimeMs);
      load.maxMtimeMs = Math.max(load.maxMtimeMs, mtimeMs);
      const task = parseTask(file);
      if (typeof task === "string") {
        load.unparsed += 1;
        continue;
      }
      const facts = factsOf(task, initiative, mtimeMs);
      if (!load.tasks.has(facts.key)) load.tasks.set(facts.key, facts);
      load.byId.set(facts.id, facts.key);
    }
  }
  return load;
}

/** A task reference as a spawn or registration writes it, `ID` or `initiative/ID`, to its key; null when no task file matches. */
export function resolveTaskRef(load: TaskLoad, ref: string): string | null {
  if (ref.includes("/")) return load.tasks.has(ref) ? ref : null;
  return load.byId.get(ref) ?? null;
}

/** Statuses a task can be dispatched from: the root's category registry when it has one, else the built-in set. */
export function dispatchableStatuses(root: string): Set<string> {
  const file = categoriesPath(root);
  const registry = existsSync(file) ? parseCategoryRegistry(parse(readFileSync(file, "utf8"))) : null;
  const statuses = registry?.status ?? BUILT_IN_STATUSES;
  return new Set(statuses.filter((s) => s.dispatchable).map((s) => s.id));
}
