import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { TaskSchema, type Task } from "@titan-design/pm";
import type { ActualsTask, TaskActuals } from "@titan-design/session-analytics";
import type { ThroughputRow } from "@titan-design/throughput";
import { parse } from "yaml";

const KIND_TAG = "kind:";

interface DoneTask extends ActualsTask {
  doneAt: string;
  kind: string | null;
  /** True when the task carries more than one `kind:` tag; the first one wins. */
  multiKind: boolean;
  estimate: number | null;
}

export interface UnparsedTask {
  file: string;
  reason: string;
}

interface DoneTaskLoad {
  tasks: DoneTask[];
  unparsed: UnparsedTask[];
  /** Allowlisted initiatives with no `tasks/` directory under the root. */
  missing: string[];
}

/** Done tasks from `<root>/<initiative>/tasks/*.yml` for each allowlisted initiative. A bad file is counted, never fatal. */
export function loadDoneTasks(root: string, initiatives: readonly string[]): DoneTaskLoad {
  const load: DoneTaskLoad = { tasks: [], unparsed: [], missing: [] };
  for (const initiative of initiatives) {
    const dir = path.join(root, initiative, "tasks");
    if (!existsSync(dir)) {
      load.missing.push(initiative);
      continue;
    }
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".yml")).sort()) {
      const file = path.join(initiative, "tasks", name);
      const task = parseTask(path.join(dir, name));
      if (typeof task === "string") load.unparsed.push({ file, reason: task });
      else if (task.status === "done" && task.done_at) load.tasks.push(toDoneTask(task, initiative, task.done_at));
    }
  }
  return load;
}

/** The parsed task, or why it would not parse. */
export function parseTask(file: string): Task | string {
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (err) {
    return `yaml: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }
  const result = TaskSchema.safeParse(raw);
  if (result.success) return result.data;
  return result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function toDoneTask(task: Task, initiative: string, doneAt: string): DoneTask {
  const kinds = kindTags(task);
  return { id: task.id, initiative, doneAt, kind: kinds[0] ?? task.kind ?? null, multiKind: kinds.length > 1, estimate: task.estimate ?? null };
}

// No task file sets the `kind` field; the kind lives in a `kind:<x>` tag, so the tag wins.
export function kindTags(task: Task): string[] {
  return (task.tags ?? []).filter((tag) => tag.startsWith(KIND_TAG)).map((tag) => tag.slice(KIND_TAG.length)).filter(Boolean);
}

function taskKey(initiative: string, id: string): string {
  return `${initiative}/${id}`;
}

/** Each actuals row with its task's plan-time kind and estimate, in the shape `@titan-design/throughput` reads. */
export function toThroughputRows(actuals: readonly TaskActuals[], tasks: readonly DoneTask[]): ThroughputRow[] {
  const byKey = new Map(tasks.map((task) => [taskKey(task.initiative, task.id), task]));
  return actuals.map((row) => {
    const task = byKey.get(taskKey(row.initiative, row.taskId));
    return { ...row, kind: task?.kind ?? null, estimate: task?.estimate ?? null, peakContextTokens: row.peakContext };
  });
}
